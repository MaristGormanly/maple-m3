/**
 * client/src/app/app.component.spec.ts — AppComponent Unit Tests
 *
 * Vitest/Angular TestBed tests for the root AppComponent. Provides
 * HttpClient and HttpClientTesting so CampusApiService can be injected
 * without making real network requests during tests.
 *
 * Test cases:
 *  - Component instantiates successfully
 *  - messages[] is initialised with exactly one assistant welcome message
 *  - The rendered template contains the MAPLE brand title in an <h1>
 *
 * Run with: `ng test` (from the client/ directory)
 */
import { TestBed } from '@angular/core/testing';
import { AppComponent } from './app.component';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';

describe('AppComponent', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [AppComponent],
      // Provide HttpClient so CampusApiService doesn't crash during tests
      providers: [provideHttpClient(), provideHttpClientTesting()] 
    }).compileComponents();
  });

  it('should create the app', () => {
    const fixture = TestBed.createComponent(AppComponent);
    const app = fixture.componentInstance;
    expect(app).toBeTruthy();
  });

  it(`should have the correct initial assistant message`, () => {
    const fixture = TestBed.createComponent(AppComponent);
    const app = fixture.componentInstance;
    expect(app.messages.length).toBe(1);
    expect(app.messages[0].role).toBe('assistant');
  });

  it('should render the MAPLE brand title', () => {
    const fixture = TestBed.createComponent(AppComponent);
    fixture.detectChanges(); // Trigger data binding
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('h1')?.textContent).toContain('MAPLE');
  });
});