/**
 * client/src/app/app.config.ts — Application-Level Provider Configuration
 *
 * Defines the root ApplicationConfig object consumed by bootstrapApplication()
 * in main.ts. Registers application-wide Angular providers:
 *  - provideHttpClient()                  — makes HttpClient injectable throughout
 *                                           the app, used by CampusApiService to call
 *                                           the backend REST API
 *  - provideBrowserGlobalErrorListeners() — wires up Angular's unhandled-error
 *                                           listeners in the browser environment
 *
 * This is the standalone-component equivalent of an NgModule's providers array.
 * Add any future app-wide providers (e.g. provideRouter, provideAnimations) here.
 */
import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideHttpClient } from '@angular/common/http'; 

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(), 
    provideHttpClient() 
  ]
};