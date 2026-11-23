/**
 * Runs before each test file is loaded. Provides safe, fixed settings for
 * tests; nothing here is a real secret. MONGO_URI is set by globalSetup.js.
 */
process.env.NODE_ENV = "test"
process.env.JWT_SECRET = "test-only-secret-0123456789-abcdefghijklmnopqrstuvwxyz"
process.env.JWT_EXPIRES_IN = "1h"
process.env.BCRYPT_SALT_ROUNDS = "4" // fast hashing for tests
process.env.LOG_LEVEL = process.env.TEST_LOG_LEVEL || "silent"
