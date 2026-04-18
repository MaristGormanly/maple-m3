/**
 * client/src/main.ts — Angular Application Bootstrap
 *
 * Entry point for the MAPLE M3 Angular client. Bootstraps the standalone
 * AppComponent using the providers declared in app.config.ts (HttpClient,
 * global error listeners). Zone.js is imported here to enable Angular's
 * default change detection.
 */
import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { AppComponent } from './app/app.component';
import 'zone.js';

bootstrapApplication(AppComponent, appConfig)
  .catch((err) => console.error(err));