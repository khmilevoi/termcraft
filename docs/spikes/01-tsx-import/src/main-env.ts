// The multi-child probe reported NODE_ENV as "development" even when the environment said
// production AND the transform demonstrably switched to production helpers. That suggests the
// bundler inlines `process.env.NODE_ENV` at compile time. If so, a compiled host cannot learn
// which JSX helper its own runtime transform will emit by reading process.env.NODE_ENV.
console.log(
  JSON.stringify({
    processEnvDot: process.env.NODE_ENV ?? null,
    processEnvBracket: process.env["NODE_ENV"] ?? null,
    bunEnvDot: Bun.env.NODE_ENV ?? null,
    fromOsViaSpread: { ...process.env }.NODE_ENV ?? null,
  }),
)
