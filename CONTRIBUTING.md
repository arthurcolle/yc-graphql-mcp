# Contributing

Small, focused contributions are welcome. Explain the behavior you are changing and how you verified it.

```sh
npm ci --ignore-scripts
npm run verify
npx playwright install chromium
npm run test:e2e
npm run pack:verify
```

Use Node 22.13 or newer. CI checks Node 22, 24 and 26. The browser test intercepts every HTTP request. Use synthetic data and fixture effects for mutation tests; never put real credentials or application answers in a fixture, issue, screenshot or pull request.

Keep mutations disabled by default. Preserve the exact-preview, session-binding, durable dispatch, terminal receipt and no-automatic-retry contracts. Changes to these boundaries need a regression that demonstrates the actual failure or effect, rather than mirroring the implementation.

Update the tool contract and operations guide when changing public semantics, bounds or recovery behavior. `npm run public:check` checks the staged Git tree before publication. Do not run the opt-in live check in CI or include local account-specific helpers in the package.

Report vulnerabilities privately using [the security policy](SECURITY.md). Do not post a session token to demonstrate an issue.
