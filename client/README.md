# Campus Navigator Client (Angular)

See the root `README.md` for the official full-project documentation.

This directory contains the Angular frontend for MAPLE M3. It was generated with Angular CLI `21.1.1` and uses standalone components.

## Local Development

1. Install dependencies:

```bash
npm install
```

2. Start the development server:

```bash
npm start
```

3. Open `http://localhost:4200/`.

The client calls the backend at `http://localhost:3000/api/v1/campus` via `src/environments/environment.development.ts`, so the backend should also be running locally.

## Available Scripts

- `npm start` — runs `ng serve`
- `npm run build` — builds the production bundle
- `npm test` — runs unit tests
- `npm run watch` — development build watcher

## Notes

- No e2e framework is currently configured in this client project.
- For architecture, API contracts, and evaluation details, use the root `README.md` and `docs/`.
