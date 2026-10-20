## What

<!-- One or two sentences. -->

- **Track / task:** <!-- e.g. T3 / T3.2 -->
- **Closes:** <!-- #issue, if one exists -->
- **Demo moment it moves:** <!-- e.g. phantom hold, approve once, lost-response recovery -->

## Evidence

- [ ] Fixture-only (fakes and testkit bundles)
- [ ] Ran against real Era images (`era_integration`)

## How I tested

<!-- Commands run, scenarios, screenshots for UI. -->

## Checklist

- [ ] `pnpm typecheck && pnpm lint && pnpm test` pass locally
- [ ] Touches `contracts/`, plan hashing, guards, executor admission or credentials → reviewer from another track requested
- [ ] Touches another track's paths → called out above
- [ ] Track file task table / handoff log updated if needed
- [ ] No secrets, `.env`, weights or image layers
