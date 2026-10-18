# Questions

_Round 0. Generated from `.hub/questions/` by `hub.py render`, so don't edit it by hand. Answer in Claude Code with `/roughcut:answer`._

## Big guesses to confirm (11)

Choices that shape everything else, made so work didn't have to wait. Confirm or change each one; changing one rebuilds the parts that depend on it.

### `hub.1` What kind of app should this be?

- **Picked:** A web app that runs in the browser, served by a small local server (npm start, then open localhost:8080)
- **Why:** A browser map is the closest thing to Google Maps that needs no app store, accounts or installs to try
- **Other options:** Phone app (React Native / Expo) for use while driving · Static website with no server, hosted free on GitHub Pages · Browser extension that adds cameras on top of Google Maps

### `hub.2` Which language and framework?

- **Picked:** JavaScript on Node.js 22+ with zero npm dependencies (built-in http, fetch and test runner); plain JS frontend with Leaflet 1.9.4 from a CDN
- **Why:** One language front and back, nothing to install, and npm test works out of the box
- **Other options:** Python + FastAPI backend with a plain JS frontend · TypeScript + React + Vite frontend with a Node backend

### `hub.3` Where should camera locations come from?

- **Picked:** OpenStreetMap, queried live through the free Overpass API (the same crowd-sourced data DeFlock maps), cached in memory
- **Why:** Free, no key, legally reusable under the ODbL with attribution, and it is where the community already maps these cameras
- **Other options:** DeFlock's own data or API (terms of use unclear, would need permission) · A downloaded OSM extract stored locally and refreshed on a schedule · Only cameras the user adds by hand

### `hub.4` Show only Flock-brand cameras, or every license plate reader?

- **Picked:** Every camera tagged surveillance:type=ALPR, with Flock Safety ones marked as Flock and routed around the same way
- **Why:** Many mapped ALPRs have no manufacturer tag, and other brands share the same networks, so filtering to Flock would miss real cameras
- **Other options:** Only cameras tagged manufacturer=Flock Safety · Let the user toggle between all ALPRs and Flock only

### `hub.5` Which routing engine plans the routes?

- **Picked:** The free public Valhalla server run by FOSSGIS (valhalla1.openstreetmap.de), using its exclude_locations option to block roads at cameras
- **Why:** It needs no account or key and can exclude roads, which OSRM cannot; a stub router keeps everything working offline
- **Other options:** OpenRouteService (free API key, avoid_polygons) · GraphHopper (free API key, custom model areas) · Self-host Valhalla or OSRM with Docker

### `hub.6` Which map tiles should the map show?

- **Picked:** Standard OpenStreetMap tiles (tile.openstreetmap.org) with the required attribution
- **Why:** Free and keyless; the tile policy allows a small interactive app that only loads tiles in view
- **Other options:** A free-tier provider like MapTiler or Stadia Maps (needs a key) · Self-hosted Protomaps vector tiles

### `hub.7` How should the avoiding route be found?

- **Picked:** Get the fastest route, find cameras within the buffer of it, block the roads at those cameras and re-route; repeat up to 4 times and show the route with the fewest cameras left
- **Why:** Blocking every camera in a city at once exceeds what the public router accepts; iterating only blocks the cameras that matter
- **Other options:** Block every camera in the trip area in one request (self-hosted router needed) · Score several alternate routes from the router and pick the one with fewest cameras, without blocking roads

### `hub.8` Is there any storage or user account?

- **Picked:** No database and no accounts; camera lookups are cached in memory for 6 hours, and an offline mode uses a bundled sample file of made-up cameras
- **Why:** The sample has nothing to save per user, and an in-memory cache keeps Overpass traffic within its fair-use policy
- **Other options:** SQLite cache of cameras and saved routes · User accounts with saved places and routes

### `hub.9` Where does the app run for now?

- **Picked:** Locally on your computer only (npm start); public hosting comes later
- **Why:** Running locally needs no hosting account and avoids sending public traffic to the free Overpass and Valhalla servers
- **Other options:** Deploy to a free host such as Render or Fly.io · Static site on GitHub Pages calling Overpass and Valhalla from the browser

### `hub.10` What should the app be called on screen, given Flock Safety has sent trademark letters to projects using its name?

- **Picked:** Keep the folder name, but title the app 'ALPR Route Planner' and never use Flock's logo or branding
- **Why:** Flock sent DeFlock a cease-and-desist over its name in 2025; a neutral title avoids that fight while the app still labels Flock cameras by name
- **Other options:** Use Flock in the title, like DeFlock did (EFF argues noncommercial criticism is protected) · Pick a different name

### `routing.1` Valhalla docs/source check: the server silently clamps any location radius, including exclude_locations radius, to its max_radius (default config 200 m). The app allows buffers up to 300 m (hub.13), so for 201-300 m buffers Valhalla only blocks roads within 200 m of a camera while the planner still counts cameras within the full buffer. What should happen above 200 m?

- **Picked:** Send radius = round(avoidRadiusM) exactly as documented and let Valhalla clamp it; the planner re-checks every returned route with the full buffer, so the counts shown stay honest (a 250 m buffer just avoids less well).
- **Why:** Keeps the interface as written and the result safe; only the 200-300 m slider range is weaker than it looks.
- **Other options:** Lower MAX_BUFFER_M to 200 so the slider matches what Valhalla can block (changes hub.13 and src/types.js) · Keep 300 m but add a UI note that buffers over 200 m are only partly enforced by the router
- **Affects:** planner, routing, web

## Needs your answer (0)

None.

## Smaller decisions this round (59)

Already built this way. Change any you disagree with.

### `api.1` How big is the 10 kB POST /api/route body limit, and what does an oversized body return?

- **Picked:** 10,000 bytes, exported as MAX_BODY_BYTES from src/server/app.js; over the limit (by Content-Length or while streaming) is 413 {error, code: "BODY_TOO_LARGE"} with Connection: close
- **Why:** SI kB matches the spec wording; checking both the header and the streamed size stops chunked bodies too
- **Affects:** api, api-tests

### `api.2` Which code values do HTTP-level errors that have no shared error class use?

- **Picked:** 404 NOT_FOUND (unknown /api path, missing or blocked static file), 405 METHOD_NOT_ALLOWED with an Allow header, 413 BODY_TOO_LARGE; malformed JSON body is 400 INPUT
- **Why:** types.js only defines codes for INPUT, TRIP_TOO_LONG, NO_ROUTE, UPSTREAM; these keep every error in the same {error, code} shape
- **Affects:** api, api-tests, web

### `api.3` What do unexpected (500) errors put in the response?

- **Picked:** code is always INTERNAL, even if the thrown error has its own code such as ENOENT; error is the thrown message ("Internal server error" for non-Error throws); the stack is logged to stderr and the server keeps running
- **Why:** keeps system error codes out of the API's code list; the message helps debugging on a local-only app
- **Affects:** api, api-tests

### `api.4` How strict is static file serving from public/?

- **Picked:** GET and HEAD only; / and any dir/ serve index.html; dotfiles, .. segments, encoded traversal, NUL bytes and symlinks that resolve outside publicDir are 404 JSON; unknown extensions are application/octet-stream; static files send Cache-Control: no-cache and API responses no-store
- **Why:** no path traversal was required; no-cache means edits to public/ show up on reload during local development
- **Affects:** api, api-tests, web

### `api.5` How does main.js read and report its environment?

- **Picked:** CAMERA_SOURCE and ROUTER are trimmed and case-insensitive, empty means the default; OFFLINE is on for any non-empty value except 0/false/no/off and overrides both; PORT must be an integer 0-65535; CONTACT is read from the env passed to configFromEnv and must be plain ASCII; a bad value or a busy port prints "Error: ..." to stderr and exits with code 1; main() resolves to the listening server
- **Why:** matches the documented env vars, with clear messages instead of stack traces; returning the server makes main testable
- **Affects:** api, api-tests

### `api.6` How exact is the bbox check in parseBbox?

- **Picked:** Exactly four plain decimal numbers (no hex, NaN or Infinity, spaces allowed), latitudes -90..90, longitudes -180..180, south <= north, west <= east, each span <= 0.5 degrees with 1e-9 degree slack for float rounding; boxes crossing the antimeridian are rejected
- **Why:** a client's exact 0.5-degree box can come out as 0.5000000000000036 after subtraction; the antimeridian is far outside the Atlanta use case
- **Affects:** api, api-tests, web

### `api-tests.2` How strictly should the acceptance tests pin the 404 / 405 / 413 error codes and the exact 10 kB byte limit?

- **Picked:** Check only the status and the {error, code} shape for 404/405/413, and test the limit with a 9.5 kB body (accepted) and a 20 kB body (rejected), both with Content-Length and chunked
- **Why:** The spec doesn't name those codes or say whether 10 kB means 10,000 or 10,240 bytes, so the builder picks; the chunked case makes sure the limit isn't enforced only from the Content-Length header.
- **Affects:** api, api-tests

### `api-tests.3` Which static-file and bbox behaviors not spelled out in the spec do the acceptance tests require?

- **Picked:** html, css and js files must be served with text/html, text/css and text/javascript (or application/javascript) Content-Types; a NUL byte in the path must get an error status without crashing the server; a zero-area bbox (south == north) is valid
- **Why:** Browsers refuse ES module scripts with other MIME types, so app.js would not load; the server must never crash on a handler error; parseBbox only rejects south > north and west > east.
- **Affects:** api, api-tests

### `api-tests.4` How should the api acceptance tests that need another module behave before that module is built?

- **Picked:** Skip themselves while planner.validatePlanRequest or cameras.loadSampleCameras still throws NotImplementedError (default planRoutes, CAMERA_SOURCE=fixture, OFFLINE=1, and the npm-run-offline start line)
- **Why:** Otherwise a missing planner or cameras module would show up as an api failure and get the api task reopened by mistake.
- **Affects:** api-tests

### `cameras.1` How should OverpassCameraSource fetch the 0.1-degree tiles a bbox is missing?

- **Picked:** One Overpass request for the bounding rectangle of all missing tiles, split back into tiles for the cache; a tile already in flight is awaited instead of requested again
- **Why:** A 50 km trip covers about 30 tiles; one request per tile would hit Overpass's per-IP rate limit and break its fair-use policy
- **Other options:** One request per tile · One request per call, no tile cache
- **Affects:** cameras

### `cameras.2` What does OverpassCameraSource.getCameras do with an invalid or huge bbox?

- **Picked:** Rejects with InputError (code INPUT) before any request, for a malformed bbox or one more than 3 degrees wide or tall
- **Why:** Keeps a bug in a caller from sending a runaway query to Overpass; real calls are at most about 0.6 degrees (API cap 0.5, planner corridor for a 50 km trip)
- **Affects:** api, cameras, planner

### `cameras.3` How are Overpass failures reported?

- **Picked:** UpstreamError('overpass', ...) for network errors, a 40 s client timeout ('request timed out'), non-2xx ('HTTP 503', 429 says 'rate limited'), bad JSON, no elements array, and HTTP 200 answers whose remark says 'runtime error'; none of these are cached
- **Why:** Overpass reports query timeouts as HTTP 200 with a remark and partial data, which must not be cached as a complete tile for 6 hours
- **Affects:** cameras

### `cameras.4` How is the OSM direction tag parsed into Camera.direction?

- **Picked:** Split on ';', take the first part that is a 16-point compass name (N, NE, NNW...) or contains a number (first number, so '45-135' gives 45), normalize to 0-360 (so '-90' gives 270); fall back to camera:direction; else null
- **Why:** Matches the interface doc and the forms these tags take in OSM; direction is only shown, never used for routing (hub.16)
- **Affects:** cameras

### `cameras.5` What goes in data/sample-cameras.json?

- **Picked:** 30 made-up cameras (ids sample:1-30), 10 Flock (manufacturer 'Flock Safety'), the rest with manufacturer null or 'Sample ALPR Vendor (made up)', operators like 'Sample City Police (made up)', placed near major central Atlanta roads; the note says they are not real
- **Why:** Enough for the offline demo to route around, and every field that could be mistaken for real data says it is made up
- **Affects:** cameras, planner, web

### `cameras.6` How strict is loadSampleCameras, and when does FixtureCameraSource read the file?

- **Picked:** InputError for an unreadable file, bad JSON, no cameras array, a missing id, or a lat/lon that is not a number in range; missing optional fields are filled in (isFlock from the manufacturer when absent, nulls, source 'sample'); the default file is read on the first getCameras call and kept
- **Why:** Callers always get full Camera objects, and constructing the source stays side-effect free as the interface constructor was written
- **Affects:** cameras

### `cameras.7` Where do helpers shared by both camera sources live?

- **Picked:** src/cameras/common.js (bbox validation, string cleanup, filter-to-bbox with dedupe by id that returns copies); internal to the module, not an interface
- **Why:** Both sources need the same bbox checks and filtering, and returning copies keeps callers from changing cached data
- **Affects:** cameras

### `cameras-tests.3` Which parts of the sample-file schema can be tested, and how loosely?

- **Picked:** Test the {note, cameras} shape, a note saying made-up/not real, 20-40 cameras, unique 'sample:<n>' ids, source 'sample', the central-Atlanta box, and 'about a third' Flock as 20%-50%; skip 'mostly on major roads' (no offline way to check) and skip what loadSampleCameras does for a missing file (not documented)
- **Why:** Only checks that follow straight from the fixture.js schema comment, with room for an approximate share
- **Other options:** Require exactly one third Flock
- **Affects:** cameras, cameras-tests

### `geo.1` How to measure point-to-line distance

- **Picked:** Per segment, project into a local equirectangular plane centred on the point to find the nearest point (earliest segment wins ties), then measure to it with haversine
- **Why:** Meets the 1% target under 100 km, is cheap, and the returned distance is a real great-circle distance to a point on the line
- **Affects:** geo, planner, routing

### `geo.2` camerasNearRoute: cameras with missing or non-finite lat/lon, and a negative buffer

- **Picked:** Skip such cameras silently; a negative buffer returns []; NaN buffer throws InputError
- **Why:** A camera with no position cannot be next to the route, and one bad OSM row should not fail a whole plan
- **Affects:** geo, planner

### `geo.3` camerasNearRoute tie-break order by id

- **Picked:** Plain string compare in code-unit order, so sample:10 sorts before sample:2
- **Why:** Matches the default JS sort, deterministic, no locale dependence
- **Affects:** geo, planner

### `geo.4` Input validation in geo

- **Picked:** Line, bbox-building, circle and polyline functions throw InputError on bad input; haversineM, bboxContains and bboxUnion do no checks
- **Why:** Clear errors where callers pass user or upstream data, no overhead on the small hot-path helpers
- **Affects:** geo, planner, routing

### `geo.5` circleRing vertex order

- **Picked:** Start due north and go counterclockwise, longitudes normalised to [-180, 180]
- **Why:** RFC 7946 exterior-ring order, which Valhalla and GeoJSON tools accept
- **Affects:** geo, routing

### `geo.6` Polyline codec details

- **Picked:** Arithmetic (not 32-bit bitwise) encoding, precision 0-10 accepted, absolute values rounded before taking deltas, malformed strings throw InputError
- **Why:** No overflow at high precision, no accumulated rounding error, and bad Valhalla output fails clearly
- **Affects:** geo, routing

### `geo.7` camerasNearRoute bbox prefilter

- **Picked:** Prefilter cameras by the route bbox grown by the buffer (1% + 1 m slack), skipped for antimeridian-crossing lines or an infinite buffer
- **Why:** Fast for many cameras and never changes the result
- **Affects:** geo

### `geo-tests.1` How strict are the geo acceptance tests about numbers?

- **Picked:** Distances (haversine, point-to-line, position along, bbox margins, circle radius) must be within 1%, the spec's accuracy target; results the JSDoc states exactly (bbox edges with no margin, the 90/180 clamps, ring length and closure, polyline strings, buffer inclusivity via bufferM 0) are checked exactly
- **Why:** The spec promises 1% under 100 km, so tighter checks would fail correct code that uses an equirectangular approximation
- **Other options:** Tight 1e-6 tolerances everywhere
- **Affects:** geo, geo-tests

### `geo-tests.2` circleRing JSDoc does not say whether the polygon sits inside the circle or around it. What do the tests accept?

- **Picked:** Both: each vertex must be between 0.99 x radiusM and 1.01 x radiusM / cos(pi / sides) from the center
- **Why:** Vertices on the circle (inscribed) and a polygon drawn around the circle so it fully covers the avoid area (circumscribed) are both fair readings of 'approximating a circle'
- **Other options:** Require vertices exactly at radiusM (inscribed only) · Require the polygon to fully cover the circle (circumscribed only)
- **Affects:** geo, geo-tests, routing

### `geo-tests.3` How do the tests check positionAlongM's documented range (between 0 and lineLengthM)?

- **Picked:** A point before the start must give >= 0 and about 0; a point 500 m past the end must give lineLengthM within 1% (so extrapolation, 10% over, fails, but approximation noise passes)
- **Why:** A strict <= lineLengthM check would fail an implementation whose along-distance uses a slightly different segment length than haversine, which the 1% accuracy target allows
- **Other options:** Strict 0 <= v <= lineLengthM(line)
- **Affects:** geo, geo-tests

### `hub.11` How are start and end picked in the sample?

- **Picked:** Click the map: first click sets start, second sets end, third starts over; address search comes later
- **Why:** Address search needs a geocoder (Nominatim) with its own usage rules; clicks show the idea without it
- **Other options:** Add address search with Nominatim now · Type coordinates into two boxes

### `hub.12` Which travel modes?

- **Picked:** Driving only
- **Why:** License plate readers watch cars; bikes and walkers are not tracked by plate
- **Other options:** Driving plus cycling · Driving, cycling and walking

### `hub.13` How close to a camera counts as passing it, by default?

- **Picked:** 75 meters, adjustable from 15 to 300 meters with a slider
- **Why:** Close enough to catch a camera on the same road without flagging every parallel street; DeFlock's planner offers a similar range
- **Other options:** 30 meters (same road only) · 150 meters (wide berth)

### `hub.14` Where should the map open?

- **Picked:** Atlanta, Georgia at zoom 13, where the offline sample cameras are also placed
- **Why:** A dense ALPR area makes the demo show something right away; the user can pan anywhere
- **Other options:** Ask the browser for your location · Zoomed-out view of the whole US

### `hub.15` How long can a trip be in the sample?

- **Picked:** Up to 50 km straight-line between start and end
- **Why:** Longer trips mean very large camera lookups and many router calls against free public servers
- **Other options:** Up to 150 km · No limit

### `hub.16` Should camera direction (which way it faces) matter?

- **Picked:** No, a camera counts in both directions of travel in the sample
- **Why:** Direction tags are often missing in OSM and matching heading to travel direction is a later refinement
- **Other options:** Use the direction tag when present and only count cameras facing your travel direction

### `hub.17` How much longer may the avoiding route be than the fastest one?

- **Picked:** No limit: the route with the fewest cameras wins however much longer it is (ties go to the faster one); the results panel shows both times so you can compare
- **Why:** Nobody asked this. The planner follows hub.7 literally, so dodging one camera can pick a route that takes twice as long
- **Other options:** Skip avoiding routes more than 50% slower than the fastest · Add a max-detour slider next to the buffer slider
- **Affects:** planner, web

### `hub.18` With live data, your trip's start and end points are sent to the public FOSSGIS Valhalla server, and the trip area to the public Overpass server. Is that acceptable for a tool meant to avoid tracking?

- **Picked:** Yes for now: live routing needs it, the app itself stores nothing, and npm run offline sends nothing; the page does not yet say where trip points go
- **Why:** Nobody asked this. hub.5 picked the public router for cost, not privacy, and someone avoiding plate readers may not want their trips on a third-party server's logs
- **Other options:** Add a line in the page saying which servers see your start and end · Self-host Valhalla with Docker so trips never leave your computer
- **Affects:** routing, web

### `hub.19` Which license should the code use?

- **Picked:** MIT, set in package.json only; there is no LICENSE file yet
- **Why:** Nobody asked this. The scaffold set it, and it matters before the repo goes public on GitHub
- **Other options:** Add an MIT LICENSE file · GPL-3.0 or AGPL-3.0 so copies must stay open source · No license (all rights reserved) until you decide

### `planner.1` Planner notes say "<n> camera(s)". Literal "(s)" or the real plural?

- **Picked:** Real plural: "1 camera", "2 cameras"
- **Why:** Reads naturally and matches the RoutePlan example in types.js; the acceptance tests accept either (planner-tests.1)
- **Affects:** planner, web

### `planner.2` Which cameras do the "can't be avoided" and "still passes" notes count?

- **Picked:** Both count the avoiding route: the first its cameras within bufferM of start or end, the second only its other (avoidable) cameras, so no camera is counted twice; a note whose count is 0 is left out
- **Why:** Matches what the map draws and avoids telling the user about the same camera twice
- **Affects:** planner

### `planner.3` Does an avoid call that fails with NoRouteError count in RoutePlan.iterations, and does "No other route was found." appear if an earlier reroute was already found?

- **Picked:** Yes to both: iterations counts every avoid call made, and the note is added whenever NoRouteError stops the search
- **Why:** iterations is documented as router calls made; the JSDoc says to add the note on NoRouteError without exceptions
- **Affects:** planner

### `planner.4` Should "Too many cameras to block them all; showing the best route found." also appear when the 4-call limit, not router.maxAvoid, ends the search?

- **Picked:** Yes, when the limit is reached and the latest route still passes a camera that could still be blocked
- **Why:** Either way the search stopped before blocking everything, and the note tells the user the result is a best effort
- **Affects:** planner

### `planner.5` What happens when an avoid call fails with an error other than NoRouteError (for example Valhalla HTTP 503)?

- **Picked:** The error propagates unchanged, so POST /api/route answers 502 even though the fastest route was found
- **Why:** Same rule as the fastest call and getCameras; there is no documented note for a cut-short search, and a silent partial result could pass for a real answer
- **Affects:** api, planner

### `planner.6` Small planRoutes details the JSDoc does not settle

- **Picked:** If every avoidable camera on a reroute is already blocked (the router ignored the avoid list) the search stops with no note; "leaves area" means any route point is outside the bbox; cameras are merged by id across fetches (duplicates dropped) and every candidate is re-counted against the final list; avoid points are sent as plain {lat, lon} copies
- **Why:** Avoids pointless repeat calls, keeps cameraIds consistent with RoutePlan.cameras, and keeps Camera fields out of router requests
- **Affects:** planner

### `planner.7` How strict is validatePlanRequest about types?

- **Picked:** No coercion: numeric strings, booleans and null are InputError for lat, lon and bufferM; only a missing bufferM gets the 75 m default; messages name the field, and TripTooLongError gives the distance and the 50 km limit
- **Why:** The JSDoc calls a non-finite bufferM an error, and the web client always sends numbers
- **Affects:** api, planner, web

### `routing.2` Other Valhalla exclude_locations surprises: (1) each point is snapped to whole road edges (intersection to intersection) within the radius, not a circular area, so one camera can block a long block of road and its cross streets; (2) if Valhalla fails to correlate the exclude list, it logs a warning and routes with NO avoids instead of returning an error; (3) the docs still call the field avoid_locations in prose (exclude_locations is the current name); (4) too many points gives error 157, mapped to UpstreamError. Change anything?

- **Picked:** No change: use exclude_locations as specified and rely on the planner re-checking camera hits on every returned route, which catches both the over-blocking and the silent drop.
- **Why:** The planner's iterative re-check already treats Valhalla as best effort; switching mechanisms would change the interface.
- **Other options:** Switch to exclude_polygons built with geo.circleRing (precise circles, but Valhalla caps total perimeter at 10 km: about 21 cameras at 75 m, 5 at 300 m)
- **Affects:** planner, routing

### `routing.3` How strict is input checking in buildValhallaRequest and StubRouter.route?

- **Picked:** InputError for a non-object request, start/end/avoid points that are not finite {lat, lon} in range, a non-array avoid, too many avoid points, and a negative or non-finite avoidRadiusM when avoid is non-empty; a missing avoid counts as empty; only lat/lon are copied from points.
- **Why:** Catches caller bugs before any network call while accepting the planner's Camera objects as avoid points.
- **Affects:** routing

### `routing.4` What do routing error messages say?

- **Picked:** NoRouteError: 'No route found: <Valhalla error text> (Valhalla error <code>)'. UpstreamError: 'valhalla: HTTP <status>: <Valhalla error text> (error <code>)', or a short reason for network failure, bad JSON or a malformed trip.
- **Why:** The API shows err.message to the user, so it should say what Valhalla said without leaking stack traces.
- **Affects:** api, routing

### `routing.5` How does StubRouter handle edge cases its JSDoc does not cover?

- **Picked:** Start equal to end: travel is taken as due east, so left is north. Longitude deltas wrap so trips across the antimeridian stay short. Waypoints use a flat local frame around the arithmetic lat/lon midpoint.
- **Why:** Deterministic, never throws for a valid request, and matches the frame the acceptance tests use.
- **Affects:** routing

### `routing.6` Where do the routing test fixtures live?

- **Picked:** test/fixtures/routing/: valhalla-route-2legs.json (a realistic two-leg Valhalla /route response) with its decoded points, plus Valhalla error bodies for 442, 171 and 157.
- **Why:** Spec says shared JSON fixtures go in test/fixtures/<module>/; planner and API tests can reuse a real-looking response.
- **Affects:** api, planner, routing

### `routing-tests.1` How do the routing acceptance tests read the StubRouter dog-leg rule ('left side then right side, nearest first')?

- **Picked:** Left means left of the direction of travel from start to end (north for an eastbound trip). Candidates are tried in the order 500 m left, 500 m right, 1000 m left, 1000 m right, 2000 m left, 2000 m right, 4000 m left, 4000 m right. The waypoint is measured in meters on the perpendicular through the start-end midpoint, with a tolerance of 2% of the offset plus 5 m. distanceM must be within 1% of the haversine length of the points.
- **Why:** Left of travel is the only meaning of 'left' that does not depend on the map projection, and 'nearest first' implies interleaving the two sides at each offset
- **Other options:** All left offsets first (500, 1000, 2000, 4000), then all right offsets · Left means the positive perpendicular in raw lat/lon degrees
- **Affects:** routing, routing-tests

### `routing-tests.2` How strict are the routing acceptance tests about the Valhalla request and error mapping?

- **Picked:** buildValhallaRequest must return exactly the documented body, with no extra keys: locations [{lat, lon}] x2, costing auto, units kilometers, directions_type none, plus exclude_locations [{lat, lon, radius: Math.round(avoidRadiusM)}] only when avoid is non-empty. A response missing trip, trip.legs or trip.summary is malformed and gives UpstreamError. A 400 with any error_code other than 442/171 (for example 154, distance limit), or a 400 that is not JSON, gives UpstreamError('valhalla'), not NoRouteError, InputError or TripTooLongError.
- **Why:** The JSDoc spells out the body and lists 442/171 as the only NoRouteError cases; anything else is 'any other non-2xx'
- **Other options:** Allow extra keys in the request body (for example costing_options)
- **Affects:** routing, routing-tests

### `web.1` What should the map do when the view is wider than the 0.5-degree camera query limit (common at zoom 12 on a wide screen)?

- **Picked:** Ask /api/cameras for the central 0.49 degrees of the view and say so in the status line ('N cameras near the center of the view (zoom in to see the edges)')
- **Why:** One small request per pan keeps Overpass load low and never hits the server's 400; the status line says what is missing
- **Other options:** Split the view into several requests · Show no cameras until zoomed in further
- **Affects:** web

### `web.2` Placeholder colors and marker styles

- **Picked:** Flock cameras red circles, other ALPRs orange circles, cameras next to a planned route larger with a dark outline; fastest route gray dashed on top, avoiding route wider solid blue underneath; start green dot, end purple dot (CSS dots, no images)
- **Why:** Two clearly different placeholder colors and overlap stays readable where both routes share a road
- **Affects:** web

### `web.3` Extra code beyond the lib.js interface

- **Picked:** Put more pure helpers (bbox clipping, marker styles, popup rows, status texts, error text) in public/view.js; test it in test/unit/web-view.test.js, and smoke-test app.js against a fake Leaflet, fake DOM and fake fetch in test/unit/web-app.test.js
- **Why:** Keeps lib.js exactly as specified while still unit-testing the DOM glue without a browser
- **Affects:** web

### `web.4` nextClickState when there is no start but an end is already set (the JSDoc does not say)

- **Picked:** Set the start and keep the existing end (the literal 'no start -> set start'); a missing end becomes null
- **Why:** Only the start is mentioned for that case; the state cannot happen through clicks anyway
- **Affects:** web, web-tests

### `web.5` Map behavior details

- **Picked:** Canvas renderer for camera markers; start/end drawn as non-interactive DOM markers so camera markers stay clickable; a click that only closes a popup does not move start/end; after planning, zooming below 12 keeps only the cameras next to the routes; changing the slider after a plan shows 'plan again' instead of replanning; if /api/config fails the map still opens with the built-in defaults and an error message
- **Why:** Each one came out of trying the page in a browser against a fake API
- **Affects:** web

### `web.6` Results panel when the fastest route is already the best one (summarizePlan same=true)

- **Picked:** Show one 'Fastest route' block plus a line: 'It passes no mapped cameras, so there is nothing to avoid.' or 'No other route passes fewer mapped cameras, so both lines are the same.'; both lines are still drawn on top of each other
- **Why:** Two identical blocks would look like a bug
- **Affects:** web

### `web-tests.1` How should formatDistance show exactly 1000 m and whole km (e.g. 2000 m)?

- **Picked:** Always one decimal: '1.0 km', '2.0 km' (literal reading of 'km with one decimal')
- **Why:** The JSDoc says km with one decimal; an acceptance test pins this so the results panel is consistent
- **Other options:** Drop a trailing .0: '1 km', '2 km'
- **Affects:** web, web-tests

### `web-tests.2` How should formatDuration show whole hours (3600 s)?

- **Picked:** '1 h 0 min': the '<h> h <rest> min' format is kept even when rest is 0
- **Why:** The JSDoc gives one format for 60+ minutes with no special case for 0 minutes
- **Other options:** '1 h' with the minutes left off
- **Affects:** web, web-tests

### `web-tests.3` What counts as 'identical points' for summarizePlan.same?

- **Picked:** Value equality of every [lat, lon] pair in order, on separate arrays parsed from JSON; any differing coordinate or length gives false
- **Why:** The plan arrives as JSON from POST /api/route, so the two point arrays are never the same object
- **Affects:** web, web-tests

## Settled (5)

- `api-tests.1` What error code should POST /api/route return for a body that is not JSON (truncated, empty, or form-encoded)? The spec gives status 400 but no code. → dismissed: same as api.2
- `cameras-tests.1` How should parseOverpass read camera direction when the JSDoc leaves details open? → dismissed: same as cameras.4
- `cameras-tests.2` How strict should the acceptance tests be about how OverpassCameraSource splits and queries tiles? → dismissed: same as cameras.1
- `planner-tests.1` The planner notes say "<n> camera(s)". Should the text read "camera(s)" literally or use the real plural ("1 camera", "2 cameras")? → dismissed: same as planner.1
- `planner-tests.2` Which planner details does the spec leave open, so the acceptance tests do not check them? → dismissed: same as planner.2, planner.3, planner.4 and planner.5
