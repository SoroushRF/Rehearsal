/**
 * Five steps, and the gate between the two worlds.
 * Wide from 640px up; stacked below that. Pass `active` to mark the current step.
 */

const LABEL = {
  1: "Copy",
  2: "Plan",
  3: "Approve",
  4: "Apply",
  5: "Receipts",
} as const;

export type ProcessStep = keyof typeof LABEL;

const STEPS = [1, 2, 3, 4, 5] as const satisfies readonly ProcessStep[];

/** Centers of the five steps on the wide diagram. Step 3 sits on the gate. */
const WIDE_X: Record<ProcessStep, number> = { 1: 96, 2: 236, 3: 380, 4: 524, 5: 664 };

/** Centers of the five steps on the stacked diagram. */
const STACK_Y: Record<ProcessStep, number> = { 1: 84, 2: 156, 3: 236, 4: 328, 5: 400 };

const ORDER = "Copy, Plan, Approve, Apply, Receipts.";
const WORLDS =
  "Copy and Plan are the planning world. Approve is the gate. Apply and Receipts are the operational world.";

function diagramLabel(active?: ProcessStep): string {
  if (active === undefined) return `${ORDER} ${WORLDS}`;
  return `Current step ${active}, ${LABEL[active]}. ${ORDER} ${WORLDS}`;
}

export function ProcessDiagram({ active }: { active?: ProcessStep }) {
  return (
    <div
      role="img"
      aria-label={diagramLabel(active)}
      className="w-full text-line-strong motion-reduce:[&_*]:transition-none!"
    >
      <Wide active={active} className="hidden h-auto w-full sm:block" />
      <Stack active={active} className="block h-auto w-full sm:hidden" />
    </div>
  );
}

function Wide({ active, className }: { active?: ProcessStep; className: string }) {
  const y = 104;
  const r = 18;
  const links = [
    [1, 2],
    [2, 3],
    [3, 4],
    [4, 5],
  ] as const satisfies readonly (readonly [ProcessStep, ProcessStep])[];
  return (
    <svg viewBox="0 0 760 180" className={className} aria-hidden="true">
      <WorldName x={72} y={28}>
        Planning world
      </WorldName>
      <Rule x1={72} y1={40} x2={268} y2={40} />
      <WorldName x={500} y={28}>
        Operational world
      </WorldName>
      <Rule x1={500} y1={40} x2={696} y2={40} />
      <Rule x1={WIDE_X[3]} y1={8} x2={WIDE_X[3]} y2={y - r} stroke="var(--ink)" />
      {links.map(([from, to]) => (
        <Rule key={from} x1={WIDE_X[from] + r} y1={y} x2={WIDE_X[to] - r} y2={y} />
      ))}
      {STEPS.map((step) => (
        <StepMark key={step} n={step} cx={WIDE_X[step]} cy={y} r={r} active={active === step} />
      ))}
      {STEPS.map((step) => (
        <StepWord key={step} x={WIDE_X[step]} y={140} active={active === step}>
          {LABEL[step]}
        </StepWord>
      ))}
    </svg>
  );
}

function Stack({ active, className }: { active?: ProcessStep; className: string }) {
  const x = 48;
  const r = 16;
  const gate = STACK_Y[3];
  return (
    <svg viewBox="0 0 320 448" className={className} aria-hidden="true">
      <WorldName x={24} y={28}>
        Planning world
      </WorldName>
      <Rule x1={24} y1={40} x2={176} y2={40} />
      <Rule x1={x} y1={STACK_Y[1] + r} x2={x} y2={STACK_Y[2] - r} />
      <Rule x1={16} y1={gate} x2={304} y2={gate} stroke="var(--ink)" />
      <rect x={68} y={gate - 12} width={92} height={24} fill="var(--canvas)" />
      <WorldName x={24} y={286}>
        Operational world
      </WorldName>
      <Rule x1={24} y1={298} x2={196} y2={298} />
      <Rule x1={x} y1={STACK_Y[4] + r} x2={x} y2={STACK_Y[5] - r} />
      {STEPS.map((step) => (
        <StepMark key={step} n={step} cx={x} cy={STACK_Y[step]} r={r} active={active === step} />
      ))}
      {STEPS.map((step) => (
        <StepWord key={step} x={80} y={STACK_Y[step]} anchor="start" active={active === step}>
          {LABEL[step]}
        </StepWord>
      ))}
    </svg>
  );
}

function StepMark({
  n,
  cx,
  cy,
  r,
  active,
}: {
  n: ProcessStep;
  cx: number;
  cy: number;
  r: number;
  active: boolean;
}) {
  return (
    <g data-step={n} data-current={active ? "true" : undefined}>
      <circle
        cx={cx}
        cy={cy}
        r={r}
        strokeWidth={1}
        vectorEffect="non-scaling-stroke"
        style={{
          fill: active ? "var(--lime)" : "var(--canvas)",
          stroke: active ? "var(--lime)" : "var(--line-strong)",
          transition: "fill 150ms ease, stroke 150ms ease",
        }}
      />
      <text
        x={cx}
        y={cy}
        textAnchor="middle"
        dominantBaseline="central"
        fill={active ? "var(--on-lime)" : "var(--muted)"}
        fontFamily="var(--font-mono)"
        fontSize={13}
      >
        {n}
      </text>
    </g>
  );
}

function StepWord({
  x,
  y,
  active,
  anchor = "middle",
  children,
}: {
  x: number;
  y: number;
  active: boolean;
  anchor?: "middle" | "start";
  children: string;
}) {
  return (
    <text
      x={x}
      y={y}
      textAnchor={anchor}
      dominantBaseline={anchor === "middle" ? "hanging" : "central"}
      fill={active ? "var(--ink)" : "var(--muted)"}
      fontFamily="var(--font-sans)"
      fontSize={14}
      fontWeight={active ? 600 : 400}
    >
      {children}
    </text>
  );
}

function WorldName({ x, y, children }: { x: number; y: number; children: string }) {
  return (
    <text x={x} y={y} fill="var(--subtle)" fontFamily="var(--font-mono)" fontSize={12}>
      {children}
    </text>
  );
}

function Rule({
  x1,
  y1,
  x2,
  y2,
  stroke = "currentColor",
}: {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  stroke?: string;
}) {
  return (
    <line
      x1={x1}
      y1={y1}
      x2={x2}
      y2={y2}
      stroke={stroke}
      strokeWidth={1}
      vectorEffect="non-scaling-stroke"
    />
  );
}
