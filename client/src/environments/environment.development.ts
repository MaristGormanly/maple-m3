/**
 * client/src/environments/environment.development.ts — Development Environment Configuration
 *
 * Consumed by CampusApiService during local development (`ng serve`). Points
 * apiUrl at the local Express backend running on port 3000.
 *
 * Angular's file replacement mechanism automatically substitutes this file for
 * environment.ts when using the development build configuration, so no code
 * changes are needed when switching between local and production targets.
 *
 * Do not store secrets here — this file is tracked in version control.
 */
export const environment = {
    production: false,
    apiUrl: 'http://localhost:3000/api/v1/campus'
  };