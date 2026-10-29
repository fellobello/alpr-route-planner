# ALPR Route Planner

A map that shows automated license plate reader (ALPR) cameras, primarily Flock Safety
cameras, and plans a driving route that avoids them.

This is a sample build and it was built by
[roughcut](https://github.com/fellobello/roughcut) from a one-line idea.

## Run

Needs Node.js 22 or newer. There are no npm dependencies to install.

    npm start          # live data: OpenStreetMap cameras via Overpass, routes via the public Valhalla server
    npm run offline    # no network: made-up sample cameras in Atlanta and a straight-line stub router

Then open localhost:8080. Click the map once for the start, again for the end.

Set `CONTACT=you@example.com` to include a contact in the User-Agent sent to Overpass and Valhalla,
if you wish to follow their usage policies.

## Test

    npm test

## Layout

    src/types.js            shared types, constants, error classes
    src/geo.js              geometry helpers
    src/cameras/            camera sources (Overpass, offline sample file)
    src/routing/            routers (Valhalla, offline stub)
    src/planner.js          fastest + avoiding route planning
    src/server/             HTTP API and static server
    public/                 browser app (Leaflet map)
    data/sample-cameras.json  made-up cameras for offline mode
    test/unit/              builders' tests
    test/acceptance/        acceptance tests written from the spec

See `.hub/spec.md` for modules and interfaces.

## Data and credits

Camera locations and map tiles are (c) OpenStreetMap contributors, available under the
Open Database License. Camera coverage is crowd-sourced and incomplete: a route that avoids
every mapped camera can still pass unmapped ones.

This project is not affiliated with Flock Safety.
