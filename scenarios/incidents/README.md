# Problem presets (live demo, #331)

`POST /api/company/problems` builds records from these and injects them into the org's planning
and operational worlds, so a signed-in team can cause the incident it then files. Each preset names
roster customers by their key in `scenarios/billing/incident.v1.json`; `count` takes the first N.

- `duplicate_charge`: a new CAD invoice charged twice, 90 s apart, inside the September window.
- `support_backlog`: a new ticket per customer, status `new` (nobody has answered it).

`service_outage` has no preset: no typed remedy exists for it yet.
