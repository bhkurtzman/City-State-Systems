# City-state planning map

A browser map for reading the ground a city-state would be built on. Each cell is 10 m × 10 m. You set the climate, then generate terrain, rivers, lakes, cover, fertility, groundwater, and mineral deposits from a seed. The same seed and settings always rebuild the same map.

The simulation is typed arrays and plain functions. The map is a canvas, one pixel per cell. Generation runs in a web worker. People, government, and the economy are not in this prototype.

## Run

```bash
npm install
npm run dev -- --port 43123
```

Open http://127.0.0.1:43123.

## Check the generator

```bash
npx tsc --noEmit
npm run lint
npm run verify
```
