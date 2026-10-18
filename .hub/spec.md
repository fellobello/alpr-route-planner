# ALPR Route Planner (flock-camera-map)

Sample version: a local web map that shows license plate reader cameras (Flock and other ALPRs) from OpenStreetMap and, after you click a start and an end, draws the fastest driving route and a route that avoids the cameras, with distance, time and cameras passed for each.

## Intake

What already exists:
- **DeFlock** (deflock.me): open-source, crowd-sourced map of ALPR cameras stored in OpenStreetMap; by 2026 it also offers a route planner with a 50-500 ft buffer. Its camera data is the same OSM data this project reads.
- **FlockHopper** and **dontgetflocked**: websites/apps that compute routes around mapped Flock cameras.
- All of them warn that coverage is incomplete and can be out of date. This project is a learning/sample build of the same idea, not a new data source.

Legal and terms notes:
- Mapping cameras that sit on public roads, and routing around them, is lawful; the data is public and crowd-sourced.
- OSM data (cameras and tiles) is under the ODbL: show "(c) OpenStreetMap contributors" visibly on the map.
- Overpass API fair use: small, cached queries and an identifying User-Agent. OSM tile policy: HTTPS URL, attribution, no bulk or offline prefetching, honor caching. FOSSGIS Valhalla public server: best-effort public service, keep load low (local-only use for now).
- Trademark: Flock Safety sent DeFlock a cease-and-desist over its name in January 2025; the EFF answered that noncommercial, critical use is protected. To stay clear, the app's on-screen title is "ALPR Route Planner", it uses no Flock logo or branding, and it says it is not affiliated with Flock Safety. Calling a camera "Flock" in its label is descriptive use of the manufacturer tag.
- The UI must say that coverage is incomplete, so nobody treats an avoiding route as a guarantee.

Decisions (all recorded with `HUB ask`, user may change them): local web app (hub.1); Node.js 22+ with zero npm dependencies, plain JS + Leaflet 1.9.4 from unpkg (hub.2); OSM via Overpass (hub.3); all ALPRs, Flock marked (hub.4); FOSSGIS Valhalla with exclude_locations (hub.5); OSM standard tiles (hub.6); iterative avoidance, max 4 router calls (hub.7); no database, 6 h in-memory cache, offline sample file (hub.8); runs locally (hub.9); title "ALPR Route Planner" (hub.10); click to set start/end (hub.11); driving only (hub.12); 75 m default buffer, 15-300 m (hub.13); opens on Atlanta at zoom 13 (hub.14); trips up to 50 km straight-line (hub.15); camera direction ignored (hub.16).

## Modules

- **geo**: pure geometry: haversine, point-to-line distance, position along a line, cameras near a route, bbox helpers, circle polygons, polyline6 encode/decode. Needs no other module's code.
- **cameras**: camera sources. `OverpassCameraSource` queries Overpass for `surveillance:type=ALPR` nodes, parses them to `Camera`, caches 0.1-degree tiles in memory for 6 h. `FixtureCameraSource` serves `data/sample-cameras.json` (20-40 made-up cameras in central Atlanta, written by this module). Needs no other module's code.
- **routing**: routers. `ValhallaRouter` calls the FOSSGIS Valhalla `/route` endpoint with `exclude_locations` for avoid points. `StubRouter` makes deterministic straight-line or dog-leg routes offline. Needs **geo** (polyline decoding, distances).
- **planner**: `planRoutes` gets the fastest route, fetches cameras for the trip area, and iterates blocking cameras to find the avoiding route; `validatePlanRequest` checks input. Needs **geo** (camera hit detection, bboxes).
- **api**: `node:http` server with `/api/health`, `/api/config`, `/api/cameras`, `/api/route`, static files from `public/`, error mapping, and `main.js` that wires sources and routers from env (`npm start`, `npm run offline`). Needs no other module's code (planner, sources and routers are used through their interfaces and injected in tests).
- **web**: browser app in `public/`: `index.html`, `style.css`, `app.js` (Leaflet map, OSM tiles with attribution, camera circle markers loaded on pan/zoom at zoom >= 12, Flock vs other ALPR in two placeholder colors, click start/end, buffer slider, "Plan route" button, fastest route dashed gray and avoiding route solid, results panel, coverage disclaimer, "not affiliated with Flock Safety") and the pure helpers in `public/lib.js`. Needs no other module's code (uses the HTTP API shapes only).

## Interfaces

All interface files below exist now with signatures, JSDoc and `NotImplementedError` bodies. Builders fill in bodies; they must not change names, signatures, shapes or documented behavior.

- `src/types.js`: the shared contract. Typedefs `LatLng {lat, lon}`, `LatLonPair [lat, lon]`, `BBox {south, west, north, east}`, `Camera`, `Route {points, distanceM, durationS}`, `RouteRequest {start, end, avoid, avoidRadiusM}`, `CameraSource {name, getCameras(bbox)}`, `Router {name, maxAvoid, route(req)}`, `PlanRequest`, `RouteResult {route, cameraIds}`, `RoutePlan {fastest, avoiding, cameras, bufferM, iterations, notes}`, `ClientConfig`. Constants (buffer limits, trip limit, corridor margin, iteration cap, bbox span limit, default center/zoom, cache TTL, User-Agent). Errors with a `code`: `InputError` (INPUT), `TripTooLongError` (TRIP_TOO_LONG), `NoRouteError` (NO_ROUTE), `UpstreamError` (UPSTREAM), `NotImplementedError`. Points are `{lat, lon}`; lines are `[lat, lon][]`; meters and seconds everywhere.
- `src/geo.js`: `haversineM`, `lineLengthM`, `pointToPolylineM`, `positionAlongM`, `camerasNearRoute`, `bboxAround`, `bboxContains`, `bboxUnion`, `circleRing` ([lon, lat] ring), `decodePolyline` / `encodePolyline` (precision 6 default). Pure functions, accurate to 1% under 100 km.
- `src/cameras/overpass.js`: `OVERPASS_ENDPOINT`, `TILE_DEG`, `buildOverpassQuery(bbox)`, `parseOverpass(json)`, `class OverpassCameraSource({endpoint, fetch, ttlMs, userAgent, now})` implementing `CameraSource` (name "overpass"); tile cache; rejects with `UpstreamError`.
- `src/cameras/fixture.js`: `SAMPLE_CAMERAS_PATH`, `loadSampleCameras(path)`, `class FixtureCameraSource({cameras})` (name "fixture"). Sample file schema `{note, cameras: Camera[]}`.
- `src/routing/valhalla.js`: `VALHALLA_ENDPOINT`, `VALHALLA_MAX_AVOID` (50), `buildValhallaRequest(req)`, `parseValhallaResponse(json)`, `class ValhallaRouter({endpoint, fetch, userAgent})` (name "valhalla"); Valhalla 442/171 -> `NoRouteError`, other failures -> `UpstreamError`.
- `src/routing/stub.js`: `STUB_SPEED_MPS`, `STUB_OFFSETS_M`, `class StubRouter` (name "stub", maxAvoid 50), deterministic straight line or dog-leg.
- `src/planner.js`: `validatePlanRequest(req)` and `planRoutes(req, {cameraSource, router}) -> RoutePlan`, with the step-by-step algorithm and exact note strings in its JSDoc.
- `src/server/app.js`: `DEFAULT_PUBLIC_DIR`, `parseBbox(text)`, `errorStatus(err)`, `createServer({cameraSource, router, planRoutes?, publicDir?})` returning an unstarted `http.Server`. HTTP API:
  - `GET /api/health` -> `{ok: true, cameraSource, router}`
  - `GET /api/config` -> `ClientConfig`
  - `GET /api/cameras?bbox=S,W,N,E` -> `{cameras: Camera[], source}`; 400 on bad or too-large bbox
  - `POST /api/route` with `PlanRequest` -> `RoutePlan`; 400 / 413 / 422 / 502 per error
  - errors are always `{error, code}`; static files from `public/`
- `src/server/main.js`: `configFromEnv(env)` and `main()`; env `PORT`, `HOST`, `CAMERA_SOURCE`, `ROUTER`, `OFFLINE`, `CONTACT`.
- `public/lib.js`: `bboxParam`, `formatDistance`, `formatDuration`, `nextClickState`, `buildRouteRequest`, `summarizePlan`, with exact output strings in JSDoc. No DOM, importable by Node.

Test file layout: builders put their tests in `test/unit/<module>*.test.js`; test tasks put acceptance tests in `test/acceptance/<module>*.test.js`. No test may use the network; inject `fetch`, sources and routers instead. Shared JSON fixtures go in `test/fixtures/<module>/`.

## Commands

- Run the app: `npm start` (offline demo: `npm run offline`)
- Run every test: `npm test`

## Out of scope

- Address search / geocoding, turn-by-turn directions, voice navigation, mobile app.
- Real icons, logos, styling and art (placeholder circle markers and default colors only).
- Camera facing direction and travel-direction matching.
- Adding, editing or reporting cameras (that belongs in OpenStreetMap / DeFlock).
- Accounts, saved routes, databases, public hosting, offline map tiles.
- Travel modes other than driving; trips over 50 km straight-line.
- Non-ALPR surveillance cameras.
