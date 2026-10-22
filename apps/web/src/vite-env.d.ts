/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Clerk publishable key. Unset means sign-in is off and the UI is read-only on fixtures. */
  readonly VITE_CLERK_PUBLISHABLE_KEY?: string;
}
