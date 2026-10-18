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

Already built this way. Change any you disagree with; the reasons are in `.hub/questions/`.

<details>
<summary>Show all 59</summary>

- `api.1` How big is the 10 kB POST /api/route body limit, and what does an oversized body return? → **10,000 bytes, exported as MAX_BODY_BYTES from src/server/app.js; over the limit (by Content-Length or while streaming) is 413 {error, code: "BODY_TOO_LARGE"} with Connection: close**
- `api.2` Which code values do HTTP-level errors that have no shared error class use? → **404 NOT_FOUND (unknown /api path, missing or blocked static file), 405 METHOD_NOT_ALLOWED with an Allow header, 413 BODY_TOO_LARGE; malformed JSON body is 400 INPUT**
- `api.3` What do unexpected (500) errors put in the response? → **code is always INTERNAL, even if the thrown error has its own code such as ENOENT; error is the thrown message ("Internal server error" for non-Error throws); the stack is logged to stderr and the server keeps running**
- `api.4` How strict is static file serving from public/? → **GET and HEAD only; / and any dir/ serve index.html; dotfiles, .. segments, encoded traversal, NUL bytes and symlinks that resolve outside publicDir are 404 JSON; unknown extensions are application/octet-stream; static files send Cache-Control: no-cache and API responses no-store**
- `api.5` How does main.js read and report its environment? → **CAMERA_SOURCE and ROUTER are trimmed and case-insensitive, empty means the default; OFFLINE is on for any non-empty value except 0/false/no/off and overrides both; PORT must be an integer 0-65535; CONTACT is read from the env passed to configFromEnv and must be plain ASCII; a bad value or a busy port prints "Error: ..." to stderr and exits with code 1; main() resolves to the listening server**
- `api.6` How exact is the bbox check in parseBbox? → **Exactly four plain decimal numbers (no hex, NaN or Infinity, spaces allowed), latitudes -90..90, longitudes -180..180, south <= north, west <= east, each span <= 0.5 degrees with 1e-9 degree slack for float rounding; boxes crossing the antimeridian are rejected**
- `api-tests.2` How strictly should the acceptance tests pin the 404 / 405 / 413 error codes and the exact 10 kB byte limit? → **Check only the status and the {error, code} shape for 404/405/413, and test the limit with a 9.5 kB body (accepted) and a 20 kB body (rejected), both with Content-Length and chunked**
- `api-tests.3` Which static-file and bbox behaviors not spelled out in the spec do the acceptance tests require? → **html, css and js files must be served with text/html, text/css and text/javascript (or application/javascript) Content-Types; a NUL byte in the path must get an error status without crashing the server; a zero-area bbox (south == north) is valid**
- `api-tests.4` How should the api acceptance tests that need another module behave before that module is built? → **Skip themselves while planner.validatePlanRequest or cameras.loadSampleCameras still throws NotImplementedError (default planRoutes, CAMERA_SOURCE=fixture, OFFLINE=1, and the npm-run-offline start line)**
- `cameras.1` How should OverpassCameraSource fetch the 0.1-degree tiles a bbox is missing? → **One Overpass request for the bounding rectangle of all missing tiles, split back into tiles for the cache; a tile already in flight is awaited instead of requested again**
- `cameras.2` What does OverpassCameraSource.getCameras do with an invalid or huge bbox? → **Rejects with InputError (code INPUT) before any request, for a malformed bbox or one more than 3 degrees wide or tall**
- `cameras.3` How are Overpass failures reported? → **UpstreamError('overpass', ...) for network errors, a 40 s client timeout ('request timed out'), non-2xx ('HTTP 503', 429 says 'rate limited'), bad JSON, no elements array, and HTTP 200 answers whose remark says 'runtime error'; none of these are cached**
- `cameras.4` How is the OSM direction tag parsed into Camera.direction? → **Split on ';', take the first part that is a 16-point compass name (N, NE, NNW...) or contains a number (first number, so '45-135' gives 45), normalize to 0-360 (so '-90' gives 270); fall back to camera:direction; else null**
- `cameras.5` What goes in data/sample-cameras.json? → **30 made-up cameras (ids sample:1-30), 10 Flock (manufacturer 'Flock Safety'), the rest with manufacturer null or 'Sample ALPR Vendor (made up)', operators like 'Sample City Police (made up)', placed near major central Atlanta roads; the note says they are not real**
- `cameras.6` How strict is loadSampleCameras, and when does FixtureCameraSource read the file? → **InputError for an unreadable file, bad JSON, no cameras array, a missing id, or a lat/lon that is not a number in range; missing optional fields are filled in (isFlock from the manufacturer when absent, nulls, source 'sample'); the default file is read on the first getCameras call and kept**
- `cameras.7` Where do helpers shared by both camera sources live? → **src/cameras/common.js (bbox validation, string cleanup, filter-to-bbox with dedupe by id that returns copies); internal to the module, not an interface**
- `cameras-tests.3` Which parts of the sample-file schema can be tested, and how loosely? → **Test the {note, cameras} shape, a note saying made-up/not real, 20-40 cameras, unique 'sample:<n>' ids, source 'sample', the central-Atlanta box, and 'about a third' Flock as 20%-50%; skip 'mostly on major roads' (no offline way to check) and skip what loadSampleCameras does for a missing file (not documented)**
- `geo.1` How to measure point-to-line distance → **Per segment, project into a local equirectangular plane centred on the point to find the nearest point (earliest segment wins ties), then measure to it with haversine**
- `geo.2` camerasNearRoute: cameras with missing or non-finite lat/lon, and a negative buffer → **Skip such cameras silently; a negative buffer returns []; NaN buffer throws InputError**
- `geo.3` camerasNearRoute tie-break order by id → **Plain string compare in code-unit order, so sample:10 sorts before sample:2**
- `geo.4` Input validation in geo → **Line, bbox-building, circle and polyline functions throw InputError on bad input; haversineM, bboxContains and bboxUnion do no checks**
- `geo.5` circleRing vertex order → **Start due north and go counterclockwise, longitudes normalised to [-180, 180]**
- `geo.6` Polyline codec details → **Arithmetic (not 32-bit bitwise) encoding, precision 0-10 accepted, absolute values rounded before taking deltas, malformed strings throw InputError**
- `geo.7` camerasNearRoute bbox prefilter → **Prefilter cameras by the route bbox grown by the buffer (1% + 1 m slack), skipped for antimeridian-crossing lines or an infinite buffer**
- `geo-tests.1` How strict are the geo acceptance tests about numbers? → **Distances (haversine, point-to-line, position along, bbox margins, circle radius) must be within 1%, the spec's accuracy target; results the JSDoc states exactly (bbox edges with no margin, the 90/180 clamps, ring length and closure, polyline strings, buffer inclusivity via bufferM 0) are checked exactly**
- `geo-tests.2` circleRing JSDoc does not say whether the polygon sits inside the circle or around it. What do the tests accept? → **Both: each vertex must be between 0.99 x radiusM and 1.01 x radiusM / cos(pi / sides) from the center**
- `geo-tests.3` How do the tests check positionAlongM's documented range (between 0 and lineLengthM)? → **A point before the start must give >= 0 and about 0; a point 500 m past the end must give lineLengthM within 1% (so extrapolation, 10% over, fails, but approximation noise passes)**
- `hub.11` How are start and end picked in the sample? → **Click the map: first click sets start, second sets end, third starts over; address search comes later**
- `hub.12` Which travel modes? → **Driving only**
- `hub.13` How close to a camera counts as passing it, by default? → **75 meters, adjustable from 15 to 300 meters with a slider**
- `hub.14` Where should the map open? → **Atlanta, Georgia at zoom 13, where the offline sample cameras are also placed**
- `hub.15` How long can a trip be in the sample? → **Up to 50 km straight-line between start and end**
- `hub.16` Should camera direction (which way it faces) matter? → **No, a camera counts in both directions of travel in the sample**
- `hub.17` How much longer may the avoiding route be than the fastest one? → **No limit: the route with the fewest cameras wins however much longer it is (ties go to the faster one); the results panel shows both times so you can compare**
- `hub.18` With live data, your trip's start and end points are sent to the public FOSSGIS Valhalla server, and the trip area to the public Overpass server. Is that acceptable for a tool meant to avoid tracking? → **Yes for now: live routing needs it, the app itself stores nothing, and npm run offline sends nothing; the page does not yet say where trip points go**
- `hub.19` Which license should the code use? → **MIT, set in package.json only; there is no LICENSE file yet**
- `planner.1` Planner notes say "<n> camera(s)". Literal "(s)" or the real plural? → **Real plural: "1 camera", "2 cameras"**
- `planner.2` Which cameras do the "can't be avoided" and "still passes" notes count? → **Both count the avoiding route: the first its cameras within bufferM of start or end, the second only its other (avoidable) cameras, so no camera is counted twice; a note whose count is 0 is left out**
- `planner.3` Does an avoid call that fails with NoRouteError count in RoutePlan.iterations, and does "No other route was found." appear if an earlier reroute was already found? → **Yes to both: iterations counts every avoid call made, and the note is added whenever NoRouteError stops the search**
- `planner.4` Should "Too many cameras to block them all; showing the best route found." also appear when the 4-call limit, not router.maxAvoid, ends the search? → **Yes, when the limit is reached and the latest route still passes a camera that could still be blocked**
- `planner.5` What happens when an avoid call fails with an error other than NoRouteError (for example Valhalla HTTP 503)? → **The error propagates unchanged, so POST /api/route answers 502 even though the fastest route was found**
- `planner.6` Small planRoutes details the JSDoc does not settle → **If every avoidable camera on a reroute is already blocked (the router ignored the avoid list) the search stops with no note; "leaves area" means any route point is outside the bbox; cameras are merged by id across fetches (duplicates dropped) and every candidate is re-counted against the final list; avoid points are sent as plain {lat, lon} copies**
- `planner.7` How strict is validatePlanRequest about types? → **No coercion: numeric strings, booleans and null are InputError for lat, lon and bufferM; only a missing bufferM gets the 75 m default; messages name the field, and TripTooLongError gives the distance and the 50 km limit**
- `routing.2` Other Valhalla exclude_locations surprises: (1) each point is snapped to whole road edges (intersection to intersection) within the radius, not a circular area, so one camera can block a long block of road and its cross streets; (2) if Valhalla fails to correlate the exclude list, it logs a warning and routes with NO avoids instead of returning an error; (3) the docs still call the field avoid_locations in prose (exclude_locations is the current name); (4) too many points gives error 157, mapped to UpstreamError. Change anything? → **No change: use exclude_locations as specified and rely on the planner re-checking camera hits on every returned route, which catches both the over-blocking and the silent drop.**
- `routing.3` How strict is input checking in buildValhallaRequest and StubRouter.route? → **InputError for a non-object request, start/end/avoid points that are not finite {lat, lon} in range, a non-array avoid, too many avoid points, and a negative or non-finite avoidRadiusM when avoid is non-empty; a missing avoid counts as empty; only lat/lon are copied from points.**
- `routing.4` What do routing error messages say? → **NoRouteError: 'No route found: <Valhalla error text> (Valhalla error <code>)'. UpstreamError: 'valhalla: HTTP <status>: <Valhalla error text> (error <code>)', or a short reason for network failure, bad JSON or a malformed trip.**
- `routing.5` How does StubRouter handle edge cases its JSDoc does not cover? → **Start equal to end: travel is taken as due east, so left is north. Longitude deltas wrap so trips across the antimeridian stay short. Waypoints use a flat local frame around the arithmetic lat/lon midpoint.**
- `routing.6` Where do the routing test fixtures live? → **test/fixtures/routing/: valhalla-route-2legs.json (a realistic two-leg Valhalla /route response) with its decoded points, plus Valhalla error bodies for 442, 171 and 157.**
- `routing-tests.1` How do the routing acceptance tests read the StubRouter dog-leg rule ('left side then right side, nearest first')? → **Left means left of the direction of travel from start to end (north for an eastbound trip). Candidates are tried in the order 500 m left, 500 m right, 1000 m left, 1000 m right, 2000 m left, 2000 m right, 4000 m left, 4000 m right. The waypoint is measured in meters on the perpendicular through the start-end midpoint, with a tolerance of 2% of the offset plus 5 m. distanceM must be within 1% of the haversine length of the points.**
- `routing-tests.2` How strict are the routing acceptance tests about the Valhalla request and error mapping? → **buildValhallaRequest must return exactly the documented body, with no extra keys: locations [{lat, lon}] x2, costing auto, units kilometers, directions_type none, plus exclude_locations [{lat, lon, radius: Math.round(avoidRadiusM)}] only when avoid is non-empty. A response missing trip, trip.legs or trip.summary is malformed and gives UpstreamError. A 400 with any error_code other than 442/171 (for example 154, distance limit), or a 400 that is not JSON, gives UpstreamError('valhalla'), not NoRouteError, InputError or TripTooLongError.**
- `web.1` What should the map do when the view is wider than the 0.5-degree camera query limit (common at zoom 12 on a wide screen)? → **Ask /api/cameras for the central 0.49 degrees of the view and say so in the status line ('N cameras near the center of the view (zoom in to see the edges)')**
- `web.2` Placeholder colors and marker styles → **Flock cameras red circles, other ALPRs orange circles, cameras next to a planned route larger with a dark outline; fastest route gray dashed on top, avoiding route wider solid blue underneath; start green dot, end purple dot (CSS dots, no images)**
- `web.3` Extra code beyond the lib.js interface → **Put more pure helpers (bbox clipping, marker styles, popup rows, status texts, error text) in public/view.js; test it in test/unit/web-view.test.js, and smoke-test app.js against a fake Leaflet, fake DOM and fake fetch in test/unit/web-app.test.js**
- `web.4` nextClickState when there is no start but an end is already set (the JSDoc does not say) → **Set the start and keep the existing end (the literal 'no start -> set start'); a missing end becomes null**
- `web.5` Map behavior details → **Canvas renderer for camera markers; start/end drawn as non-interactive DOM markers so camera markers stay clickable; a click that only closes a popup does not move start/end; after planning, zooming below 12 keeps only the cameras next to the routes; changing the slider after a plan shows 'plan again' instead of replanning; if /api/config fails the map still opens with the built-in defaults and an error message**
- `web.6` Results panel when the fastest route is already the best one (summarizePlan same=true) → **Show one 'Fastest route' block plus a line: 'It passes no mapped cameras, so there is nothing to avoid.' or 'No other route passes fewer mapped cameras, so both lines are the same.'; both lines are still drawn on top of each other**
- `web-tests.1` How should formatDistance show exactly 1000 m and whole km (e.g. 2000 m)? → **Always one decimal: '1.0 km', '2.0 km' (literal reading of 'km with one decimal')**
- `web-tests.2` How should formatDuration show whole hours (3600 s)? → **'1 h 0 min': the '<h> h <rest> min' format is kept even when rest is 0**
- `web-tests.3` What counts as 'identical points' for summarizePlan.same? → **Value equality of every [lat, lon] pair in order, on separate arrays parsed from JSON; any differing coordinate or length gives false**

</details>

## Settled (5)

- `api-tests.1` What error code should POST /api/route return for a body that is not JSON (truncated, empty, or form-encoded)? The spec gives status 400 but no code. → dismissed: same as api.2
- `cameras-tests.1` How should parseOverpass read camera direction when the JSDoc leaves details open? → dismissed: same as cameras.4
- `cameras-tests.2` How strict should the acceptance tests be about how OverpassCameraSource splits and queries tiles? → dismissed: same as cameras.1
- `planner-tests.1` The planner notes say "<n> camera(s)". Should the text read "camera(s)" literally or use the real plural ("1 camera", "2 cameras")? → dismissed: same as planner.1
- `planner-tests.2` Which planner details does the spec leave open, so the acceptance tests do not check them? → dismissed: same as planner.2, planner.3, planner.4 and planner.5
