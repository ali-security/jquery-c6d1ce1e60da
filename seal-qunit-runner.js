#!/usr/bin/env node
/*
 * Headless-Chrome runner for jQuery's browser QUnit suite (test/index.html).
 *
 * Upstream runs this suite only in real browsers (TestSwarm); there is no
 * Node runner for it. This script serves the repository with PHP's built-in
 * server (test/data/*.php backs the ajax tests), opens test/index.html in
 * headless Chrome through puppeteer-core, prints one line per test, a
 * per-module tally and a summary, and exits non-zero on any failure.
 *
 * test/index.html runs the whole suite: test/data/testinit.js loadTests()
 * loads every unit file it lists (core, callbacks, deferred, support, data,
 * queue, attributes, event, selector, traversing, manipulation, wrap, css,
 * serialize, ajax, effects, offset, dimensions) and test/jquery.js adds
 * test/unit/ready.js.
 *
 * Environment:
 *   CHROME_PATH      Chrome binary (default: `google-chrome` on PATH)
 *   SEAL_PHP         php binary (default: php)
 *   SEAL_PORT        server port (default: 8000)
 *   SEAL_TEST_QUERY  query string for test/index.html (default: "dev",
 *                    i.e. load the unminified dist/jquery.js)
 *   SEAL_SKIP_TESTS  tests to de-register, separated by newlines or "|".
 *                    Each entry is "<module>: <test name>" (or a bare test
 *                    name, matched in any module). Entries that match no
 *                    declared test fail the run, so a stale exclusion
 *                    can't hide silently.
 *   SEAL_TIMEOUT_MIN overall timeout in minutes (default: 30)
 *
 * puppeteer-core is resolved through NODE_PATH so it can live outside the
 * repository's own node_modules.
 */
"use strict";

const { spawn, execFileSync } = require( "child_process" );
const http = require( "http" );
const puppeteer = require( "puppeteer-core" );

const ROOT = __dirname;
const PORT = Number( process.env.SEAL_PORT || 8000 );
const QUERY = process.env.SEAL_TEST_QUERY === undefined ? "dev" : process.env.SEAL_TEST_QUERY;
const TIMEOUT_MS = Number( process.env.SEAL_TIMEOUT_MIN || 30 ) * 60 * 1000;
const SKIP = ( process.env.SEAL_SKIP_TESTS || "" )
	.split( /[\n|]/ )
	.map( ( s ) => s.trim() )
	.filter( Boolean );
const PREFIX = "__SEAL_QUNIT__";

function chromePath() {
	if ( process.env.CHROME_PATH ) {
		return process.env.CHROME_PATH;
	}
	return execFileSync( "which", [ "google-chrome" ], { encoding: "utf8" } ).trim();
}

function waitForServer( url, deadline ) {
	return new Promise( ( resolve, reject ) => {
		const attempt = () => {
			http.get( url, ( res ) => {
				res.resume();
				resolve();
			} ).on( "error", () => {
				if ( Date.now() > deadline ) {
					reject( new Error( "PHP server did not come up at " + url ) );
				} else {
					setTimeout( attempt, 200 );
				}
			} );
		};
		attempt();
	} );
}

// Runs in every frame before any page script. Only the top frame (the
// QUnit page itself) is instrumented; fixture iframes are left alone.
//
// QUnit 1.14 (test/libs/qunit) copies its API onto window (the globals
// test/asyncTest/... the unit files call) and only then assigns
// window.QUnit, so the setter below sees both and can wrap them.
function pageInstrumentation( prefix, skipList ) {
	if ( window.top !== window ) {
		return;
	}

	// Snapshot natives: some tests stub window.JSON / console methods
	// (and "?basic" nulls window.JSON).
	const stringify = JSON.stringify.bind( JSON );
	const log = console.log.bind( console );
	const emit = ( type, data ) => {
		try {
			log( prefix + stringify( { type, data } ) );
		} catch ( e ) {
			try {
				log( prefix + "{\"type\":\"emit-error\",\"data\":\"" +
					String( e ).replace( /["\\\n]/g, " " ) + "\"}" );
			} catch ( e2 ) {}
		}
	};
	const str = ( v ) => {
		try {
			return typeof v === "string" ? v : String( stringify( v ) );
		} catch ( e ) {
			return String( v );
		}
	};

	const skip = new Set( skipList );
	const usedSkips = new Set();
	let qunit;
	let instrumented = false;

	const instrument = ( Q ) => {
		if ( instrumented || !Q || typeof Q.test !== "function" ) {
			return;
		}
		instrumented = true;
		Q.config.reorder = false;

		// QUnit.asyncTest delegates to QUnit.test, so wrapping test covers
		// both; the global `test` is re-pointed at the wrapper.
		const originalTest = Q.test;
		Q.test = function( name ) {

			// QUnit 1.x keeps the current module as a plain string.
			const mod = Q.config.currentModule || "";
			const full = mod + ": " + name;
			const hit = skip.has( full ) ? full : skip.has( name ) ? name : null;
			if ( hit !== null ) {
				usedSkips.add( hit );
				emit( "skipped", { module: mod, name: String( name ) } );
				return undefined;
			}
			return originalTest.apply( this, arguments );
		};
		window.test = Q.test;

		let failedAssertions = [];
		Q.moduleStart( ( d ) => emit( "moduleStart", { name: d.name } ) );
		Q.moduleDone( ( d ) => emit( "moduleDone", {
			name: d.name,
			failed: d.failed,
			passed: d.passed,
			total: d.total
		} ) );
		Q.testStart( () => {
			failedAssertions = [];
		} );
		Q.log( ( d ) => {
			if ( !d.result ) {
				failedAssertions.push( {
					message: d.message === undefined ? "" : String( d.message ),
					actual: str( d.actual ),
					expected: str( d.expected ),
					source: d.source ? String( d.source ).split( "\n" ).slice( 0, 3 ).join( " | " ) : ""
				} );
			}
		} );
		Q.testDone( ( d ) => emit( "testDone", {
			module: d.module || "",
			name: d.name,
			failed: d.failed,
			passed: d.passed,
			total: d.total,
			runtime: d.runtime,
			assertions: failedAssertions
		} ) );
		Q.done( ( d ) => emit( "done", {
			failed: d.failed,
			passed: d.passed,
			total: d.total,
			runtime: d.runtime,
			unusedSkips: skipList.filter( ( s ) => !usedSkips.has( s ) )
		} ) );
	};

	Object.defineProperty( window, "QUnit", {
		configurable: true,
		enumerable: true,
		get() {
			return qunit;
		},
		set( v ) {
			qunit = v;
			instrument( v );
		}
	} );
}

async function main() {
	const url = "http://127.0.0.1:" + PORT + "/test/index.html" + ( QUERY ? "?" + QUERY : "" );
	const deadline = Date.now() + TIMEOUT_MS;

	let finished = false;

	// PHP listens on private ports behind a Node pass-through proxy (below):
	// a pool of independent single-process `php -S` servers on consecutive
	// ports starting at SEAL_PHP_PORT (default SEAL_PORT + 1). SEAL_PHP_SERVERS
	// sets the pool size (default 8). PHP_CLI_SERVER_WORKERS is not relied on:
	// on some PHP 7.4 builds it behaves as a single worker.
	const PHP_BASE_PORT = Number( process.env.SEAL_PHP_PORT || PORT + 1 );
	const requestedServers = Math.floor( Number( process.env.SEAL_PHP_SERVERS || 8 ) );
	const PHP_SERVERS = requestedServers >= 1 ? requestedServers : 8;
	const backends = [];
	for ( let i = 0; i < PHP_SERVERS; i++ ) {
		const port = PHP_BASE_PORT + i;
		const proc = spawn( process.env.SEAL_PHP || "php",
			[ "-S", "127.0.0.1:" + port, "-t", ROOT ], {
				cwd: ROOT,
				stdio: [ "ignore", "ignore", "ignore" ]
			} );
		proc.on( "exit", ( code ) => {
			if ( !finished ) {
				console.error( "PHP server on port " + port + " exited early with code " + code );
				process.exit( 1 );
			}
		} );
		backends.push( { index: i, port, proc, inFlight: 0, taintedUntil: 0 } );
	}
	const killPhp = () => {
		for ( const b of backends ) {
			try {
				b.proc.kill();
			} catch ( e ) {}
		}
	};

	// Don't leave the rest of the pool running when the runner exits early.
	process.on( "exit", killPhp );

	await Promise.all( backends.map( ( b ) => waitForServer(
		"http://127.0.0.1:" + b.port + "/test/index.html", Date.now() + 30000 ) ) );

	// A PHP built-in server handles one request at a time, so a long-running
	// fixture (test/data/core/dont_return.php sleeps 30s) blocks it - and PHP
	// keeps executing the script after Chrome aborts the request (~40ms in),
	// so the next request on that server (e.g. the next iframe fixture,
	// test/data/core/aliased.html) hangs until the sleep ends and the QUnit
	// test times out. Chrome therefore talks only to this proxy, which keeps
	// idle sockets itself and opens a fresh PHP connection per request
	// (agent: false) to the pool member with the fewest in-flight requests,
	// preferring an idle one that has not recently had a request aborted
	// mid-flight (such a server is "tainted" for TAINT_MS, since its PHP
	// process may still be running the aborted script). When every server is
	// busy it falls back to the least-loaded one. Status line, headers and
	// body pass through unchanged.
	const TAINT_MS = 35000;
	let nextBackend = 0;
	const pickBackend = () => {
		const now = Date.now();
		const n = backends.length;
		let best = null;

		// Idle and untainted, round-robin from the last pick.
		for ( let k = 0; k < n && !best; k++ ) {
			const b = backends[ ( nextBackend + k ) % n ];
			if ( b.inFlight === 0 && b.taintedUntil <= now ) {
				best = b;
			}
		}

		// Otherwise least-loaded; ties go to the earliest taint expiry, then
		// the lowest index.
		if ( !best ) {
			for ( const b of backends ) {
				if ( !best || b.inFlight < best.inFlight ||
					( b.inFlight === best.inFlight && b.taintedUntil < best.taintedUntil ) ) {
					best = b;
				}
			}
		}
		nextBackend = ( best.index + 1 ) % n;
		return best;
	};

	const proxy = http.createServer( ( req, res ) => {
		const backend = pickBackend();
		backend.inFlight++;
		let released = false;
		const release = () => {
			if ( !released ) {
				released = true;
				backend.inFlight--;
			}
		};
		let completed = false;

		const upstream = http.request( {
			host: "127.0.0.1",
			port: backend.port,
			method: req.method,
			path: req.url,
			headers: req.headers,
			agent: false
		}, ( up ) => {
			res.writeHead( up.statusCode, up.statusMessage, up.headers );
			up.on( "end", () => {
				completed = true;
				release();
			} );
			up.pipe( res );
		} );
		upstream.on( "error", ( err ) => {

			// Not a client abort (that path sets completed first and taints).
			completed = true;
			release();
			if ( !res.headersSent ) {
				res.writeHead( 502 );
			}
			res.end();
			console.log( "[runner] proxy error: " + req.url + " (" + err.message + ")" );
		} );

		// The upstream socket is gone: the backend no longer holds this request.
		upstream.on( "close", release );
		res.on( "close", () => {
			if ( !completed ) {

				// Client aborted mid-flight: PHP keeps running the script after
				// the disconnect, so keep this server out of rotation for a while.
				backend.taintedUntil = Date.now() + TAINT_MS;
				console.log( "[runner] proxy: client aborted " + req.url +
					" on PHP port " + backend.port + "; tainted for " + TAINT_MS + "ms" );
			}
			completed = true;
			upstream.destroy();
		} );
		req.pipe( upstream );
	} );
	await new Promise( ( resolve, reject ) => {
		proxy.once( "error", reject );
		proxy.listen( PORT, "127.0.0.1", resolve );
	} );

	const browser = await puppeteer.launch( {
		executablePath: chromePath(),
		headless: true,
		args: [
			"--no-sandbox",
			"--disable-gpu",
			"--disable-dev-shm-usage",
			"--disable-background-timer-throttling",
			"--disable-backgrounding-occluded-windows",
			"--disable-renderer-backgrounding",
			"--window-size=1280,1024"
		],
		defaultViewport: { width: 1280, height: 1024 }
	} );

	const shutdown = async( code ) => {
		finished = true;
		try {
			await browser.close();
		} catch ( e ) {}
		killPhp();
		process.exit( code );
	};

	const page = await browser.newPage();
	let tests = 0;
	let failedTests = 0;
	let excluded = 0;
	const failures = [];
	const modules = new Map();
	const excludedByModule = new Map();
	const moduleTally = ( name ) => {
		if ( !modules.has( name ) ) {
			modules.set( name, { tests: 0, failedTests: 0, passed: 0, failed: 0 } );
		}
		return modules.get( name );
	};

	const result = new Promise( ( resolve ) => {
		page.on( "console", ( msg ) => {
			const text = msg.text();
			if ( !text.startsWith( PREFIX ) ) {
				return;
			}
			let ev;
			try {
				ev = JSON.parse( text.slice( PREFIX.length ) );
			} catch ( e ) {
				console.log( "[runner] unparsable event: " + text.slice( 0, 200 ) );
				return;
			}
			const d = ev.data;
			if ( ev.type === "moduleStart" ) {
				moduleTally( d.name || "" );
				console.log( "\n# Module: " + d.name );
			} else if ( ev.type === "moduleDone" ) {
				const m = moduleTally( d.name || "" );
				console.log( "# Module done: " + d.name + " - tests: " + m.tests + " (" +
					m.failedTests + " failed), assertions: " + d.passed + " passed, " +
					d.failed + " failed, " + d.total + " total" );
			} else if ( ev.type === "skipped" ) {
				excluded++;
				excludedByModule.set( d.module, ( excludedByModule.get( d.module ) || 0 ) + 1 );
				console.log( "EXCLUDED  " + d.module + ": " + d.name );
			} else if ( ev.type === "testDone" ) {
				tests++;
				const m = moduleTally( d.module );
				m.tests++;
				m.passed += d.passed;
				m.failed += d.failed;
				const ok = d.failed === 0;
				const line = ( ok ? "ok    " : "FAIL  " ) + d.module + ": " + d.name +
					" (" + d.passed + "/" + d.total + " assertions, " + d.runtime + "ms)";
				console.log( line );
				if ( !ok ) {
					failedTests++;
					m.failedTests++;
					failures.push( line );
					for ( const a of d.assertions ) {
						console.log( "        - " + a.message );
						console.log( "          expected: " + a.expected );
						console.log( "          actual:   " + a.actual );
						if ( a.source ) {
							console.log( "          at: " + a.source );
						}
					}
				}
			} else if ( ev.type === "done" ) {
				resolve( d );
			} else if ( ev.type === "emit-error" ) {
				console.log( "[runner] emit error: " + d );
			}
		} );
	} );

	page.on( "pageerror", ( err ) => {
		console.log( "[page error] " + ( err && err.message || err ) );
	} );
	page.on( "dialog", ( dialog ) => dialog.dismiss() );

	// Network diagnostics (main page and same-process fixture iframes), so a
	// stalled iframe/ajax fixture can be traced to a failed, erroring or slow
	// request. Written straight to stdout; never routed through the page
	// console, so the PREFIX event parsing above is unaffected.
	const SLOW_REQUEST_MS = 3000;
	const requestStart = new WeakMap();
	page.on( "request", ( req ) => {
		requestStart.set( req, Date.now() );
	} );
	page.on( "requestfinished", ( req ) => {
		const started = requestStart.get( req );
		if ( started !== undefined && Date.now() - started >= SLOW_REQUEST_MS ) {
			console.log( "[runner] slow request " + ( Date.now() - started ) + "ms " + req.url() );
		}
	} );
	page.on( "requestfailed", ( req ) => {
		const failure = req.failure();
		const started = requestStart.get( req );
		console.log( "[runner] request failed: " + req.url() + " (" +
			( failure && failure.errorText || "unknown error" ) +
			( started !== undefined ? ", after " + ( Date.now() - started ) + "ms" : "" ) + ")" );
	} );
	page.on( "response", ( res ) => {
		if ( res.status() >= 400 ) {
			console.log( "[runner] HTTP " + res.status() + " " + res.url() );
		}
	} );

	await page.evaluateOnNewDocument( pageInstrumentation, PREFIX, SKIP );

	console.log( "Opening " + url );
	console.log( "Chrome: " + await browser.version() );
	await page.goto( url, { waitUntil: "load", timeout: 120000 } );

	const timer = new Promise( ( resolve ) => setTimeout( () => resolve( null ),
		deadline - Date.now() ) );
	const done = await Promise.race( [ result, timer ] );

	if ( !done ) {
		console.log( "\nTIMEOUT: suite did not finish within " + TIMEOUT_MS / 60000 +
			" minutes (" + tests + " tests reported)" );
		return shutdown( 1 );
	}

	console.log( "\nPer-module results:" );
	for ( const name of excludedByModule.keys() ) {
		moduleTally( name );
	}
	for ( const [ name, m ] of modules ) {
		console.log( "  " + name + ": " + m.tests + " tests (" + m.failedTests + " failed, " +
			( excludedByModule.get( name ) || 0 ) + " excluded), assertions: " + m.passed +
			" passed, " + m.failed + " failed" );
	}

	console.log( "\nTests: " + ( tests - failedTests ) + " passed, " + failedTests +
		" failed, " + excluded + " excluded, " + tests + " total; Assertions: " +
		done.passed + " passed, " + done.failed + " failed, " + done.total + " total (" +
		done.runtime + "ms)" );
	if ( failures.length ) {
		console.log( "\nFailed tests:" );
		failures.forEach( ( f ) => console.log( "  " + f ) );
	}
	if ( done.unusedSkips.length ) {
		console.log( "\nExclusions that matched no declared test:" );
		done.unusedSkips.forEach( ( s ) => console.log( "  " + s ) );
	}
	const ok = done.failed === 0 && failedTests === 0 && tests > 0 &&
		done.unusedSkips.length === 0;
	return shutdown( ok ? 0 : 1 );
}

main().catch( ( err ) => {
	console.error( err && err.stack || err );
	process.exit( 1 );
} );
