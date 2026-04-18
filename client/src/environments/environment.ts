/**
 * client/src/environments/environment.ts — Production Environment Configuration
 *
 * Consumed by CampusApiService when the app is built with the production
 * configuration (`ng build`). Points apiUrl at the live Final Project deployment.
 *
 * Angular's file replacement mechanism swaps this file for
 * environment.development.ts when running `ng serve` (development build),
 * so local development automatically targets http://localhost:3000.
 *
 * Do not store secrets here — this file is bundled into the client JavaScript.
 */
export const environment = {
    production: true,
    apiUrl: 'https://m3.maristchat.com/api/v1/campus' // Production URL for Final Project
  };