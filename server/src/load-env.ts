// Loads server/.env for local development (Node >= 20.12 built-in). In production the host
// injects real environment variables and there is no .env file.
try {
  process.loadEnvFile();
} catch {
  // no .env file: fine
}
