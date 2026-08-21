import { useMemo, useState } from 'react';
import type { SaveDataV6, WeaponBuild, WeaponChassisId, WeaponDefinition, WeaponPartDefinition, WeaponPartSlot } from '../contracts';
import { bladeStyles } from '../content/blades';
import { getWeaponChassis, partsForSlot, resolveWeaponStats, weaponChassis, weaponPartSlots } from '../content/weapons';
import { Section, Tabs, UiButton } from './Primitives';
import { WeaponPreview } from './WeaponPreview';

interface WeaponBuilderProps {
  save: SaveDataV6;
  onChange: (next: SaveDataV6) => void;
  onClose: () => void;
  /** Shown when the builder is open mid-run, where changes wait for a respawn. */
  deferredNotice?: boolean;
  /** Parks the weapon turntable instead of spinning it. */
  reducedMotion?: boolean;
}

/** Every stat a part can move, with the direction that counts as an improvement. */
const STAT_META = {
  damage: { label: 'Damage', higherIsBetter: true },
  roundsPerMinute: { label: 'Rate of fire', higherIsBetter: true },
  magazineSize: { label: 'Magazine', higherIsBetter: true },
  reserveAmmo: { label: 'Reserve', higherIsBetter: true },
  range: { label: 'Range', higherIsBetter: true },
  reloadSeconds: { label: 'Reload', higherIsBetter: false },
  adsSpread: { label: 'Aimed spread', higherIsBetter: false },
  hipSpread: { label: 'Hip spread', higherIsBetter: false },
  adsZoom: { label: 'Zoom', higherIsBetter: true },
  headshotMultiplier: { label: 'Headshot', higherIsBetter: true },
  recoilPitch: { label: 'Vertical kick', higherIsBetter: false },
  recoilYaw: { label: 'Horizontal kick', higherIsBetter: false },
  recoilRecovery: { label: 'Recovery', higherIsBetter: true },
  bloomPerShot: { label: 'Bloom', higherIsBetter: false },
  bloomMax: { label: 'Bloom ceiling', higherIsBetter: false },
  bloomRecovery: { label: 'Bloom recovery', higherIsBetter: true },
} as const satisfies Partial<Record<keyof WeaponDefinition, { label: string; higherIsBetter: boolean }>>;

type StatKey = keyof typeof STAT_META;

/** The rows the bench draws, with the range each bar is scaled against. */
const STAT_ROWS = [
  { key: 'damage', max: 90 },
  { key: 'roundsPerMinute', max: 1200 },
  { key: 'magazineSize', max: 90 },
  { key: 'range', max: 260 },
  { key: 'reloadSeconds', max: 3.2 },
  { key: 'adsSpread', max: 0.05 },
  { key: 'hipSpread', max: 0.12 },
] as const satisfies readonly { key: StatKey; max: number }[];

const slotLabels: Record<WeaponPartSlot, string> = {
  optic: 'Optic',
  barrel: 'Barrel',
  magazine: 'Magazine',
  grip: 'Grip',
  stock: 'Stock',
};

function formatStat(key: StatKey, value: number): string {
  if (key === 'adsSpread' || key === 'hipSpread') return value.toFixed(4);
  if (key === 'reloadSeconds') return `${value.toFixed(2)} s`;
  return String(Math.round(value));
}

/** What fitting a part would do to the build, as signed percentages. */
function partEffects(build: WeaponBuild, slot: WeaponPartSlot, part: WeaponPartDefinition) {
  const current = resolveWeaponStats(build);
  const fitted = resolveWeaponStats({ ...build, parts: { ...build.parts, [slot]: part.id } });
  const effects: { key: StatKey; label: string; percent: number; better: boolean }[] = [];
  for (const key of Object.keys(STAT_META) as StatKey[]) {
    const from = current[key];
    const to = fitted[key];
    if (!from || Math.abs(to - from) < Math.abs(from) * 0.005) continue;
    const percent = ((to - from) / from) * 100;
    effects.push({ key, label: STAT_META[key].label, percent, better: STAT_META[key].higherIsBetter === to > from });
  }
  // Loudest first: a part is chosen on what it changes most, not alphabetically.
  return effects.sort((a, b) => Math.abs(b.percent) - Math.abs(a.percent));
}

function signedPercent(percent: number): string {
  return `${percent > 0 ? '+' : '−'}${Math.abs(percent).toFixed(0)}%`;
}

export function WeaponBuilder({ save, onChange, onClose, deferredNotice = false, reducedMotion = false }: WeaponBuilderProps) {
  const [editingId, setEditingId] = useState(() => save.loadout[0] ?? save.armory[0]?.id ?? '');
  const [activeSlot, setActiveSlot] = useState<WeaponPartSlot>('optic');
  /** The part under the cursor, previewed on the stat bars before it is committed. */
  const [previewPartId, setPreviewPartId] = useState<string | null>(null);
  const build = save.armory.find((entry) => entry.id === editingId) ?? save.armory[0];
  const stats = useMemo(() => (build ? resolveWeaponStats(build) : null), [build]);
  const baseStats = useMemo(() => (build ? getWeaponChassis(build.chassisId)?.base ?? null : null), [build]);
  const previewStats = useMemo(
    () => (build && previewPartId ? resolveWeaponStats({ ...build, parts: { ...build.parts, [activeSlot]: previewPartId } }) : null),
    [build, previewPartId, activeSlot],
  );

  if (!build || !stats || !baseStats) {
    return (
      <section className="weapon-builder" aria-label="Weapon builder">
        <p className="muted">No builds available.</p>
        <UiButton onClick={onClose}>Back</UiButton>
      </section>
    );
  }

  const commit = (next: WeaponBuild) => {
    onChange({ ...save, armory: save.armory.map((entry) => (entry.id === next.id ? next : entry)) });
  };

  const setSlot = (slot: WeaponPartSlot, partId: string) => {
    commit({ ...build, parts: { ...build.parts, [slot]: partId } });
  };

  const addBuild = () => {
    const id = `build-${Date.now().toString(36)}`;
    const created: WeaponBuild = { id, name: `Build ${save.armory.length + 1}`, chassisId: 'carbine', parts: {} };
    onChange({ ...save, armory: [...save.armory, created] });
    setEditingId(id);
  };

  const deleteBuild = () => {
    // Never leave the armory empty or a loadout slot pointing at nothing.
    if (save.armory.length <= 1) return;
    const remaining = save.armory.filter((entry) => entry.id !== build.id);
    const loadout = save.loadout.map((id) => (id === build.id ? remaining[0].id : id)) as unknown as readonly [string, string];
    onChange({ ...save, armory: remaining, loadout });
    setEditingId(remaining[0].id);
  };

  const assignSlot = (index: 0 | 1) => {
    const loadout: [string, string] = [save.loadout[0], save.loadout[1]];
    loadout[index] = build.id;
    onChange({ ...save, loadout });
  };

  const loadoutIndex = save.loadout.indexOf(build.id);
  const chassis = getWeaponChassis(build.chassisId);
  const slotOptions = partsForSlot(build.chassisId, activeSlot);
  const fittedInSlot = (slot: WeaponPartSlot) => build.parts[slot] ?? partsForSlot(build.chassisId, slot)[0]?.id ?? '';

  return (
    <section className="weapon-builder" aria-label="Weapon builder">
      <header className="builder-header">
        <div>
          <p className="eyebrow">Loadout bench</p>
          <h2>{build.name}</h2>
        </div>
        <UiButton onClick={onClose}>Done</UiButton>
      </header>

      {deferredNotice && <p className="builder-notice" role="status">Changes apply at your next checkpoint respawn.</p>}

      <div className="builder-body">
        <div className="builder-column builder-armory">
          <Section title="Armory" meta={`${save.armory.length}`}>
            <div className="scene-list" aria-label="Saved builds">
              {save.armory.map((entry) => (
                <button
                  key={entry.id}
                  className={entry.id === build.id ? 'selected' : ''}
                  onClick={() => setEditingId(entry.id)}
                >
                  <i className="visual-dot" />{entry.name}
                  <small>{getWeaponChassis(entry.chassisId)?.label ?? entry.chassisId}</small>
                </button>
              ))}
            </div>
            <div className="builder-actions">
              <UiButton onClick={addBuild}>New build</UiButton>
              <UiButton tone="danger" disabled={save.armory.length <= 1} onClick={deleteBuild}>Delete</UiButton>
            </div>
          </Section>

          {/* The blade, first, because it is the primary verb -- and it is *chosen* rather
              than assembled. What a style buys is a different rule for building a chain,
              which is why each card says what it does to the chain and not what it does
              to a damage bar. See `content/blades.ts` for why it is not a parts game. */}
          <Section title="Blade" meta={bladeStyles.find((style) => style.id === save.blade)?.label ?? 'Tempo'}>
            <div className="blade-styles" role="radiogroup" aria-label="Blade style">
              {bladeStyles.map((style) => (
                <button
                  key={style.id}
                  role="radio"
                  aria-checked={save.blade === style.id}
                  className={`blade-style ${save.blade === style.id ? 'selected' : ''}`}
                  onClick={() => onChange({ ...save, blade: style.id })}
                >
                  <i className="blade-swatch" style={{ background: style.accent }} aria-hidden="true" />
                  <strong>{style.label}</strong>
                  <small>{style.description}</small>
                  <em>{style.chainNote}</em>
                </button>
              ))}
            </div>
          </Section>

          <Section title="Loadout" meta={loadoutIndex >= 0 ? `Slot ${loadoutIndex + 1}` : 'Not carried'}>
            <p className="muted">The blade is the primary. Two guns are carried as sidearms.</p>
            <div className="builder-actions">
              <UiButton tone={save.loadout[0] === build.id ? 'primary' : 'neutral'} onClick={() => assignSlot(0)}>Carry as 1</UiButton>
              <UiButton tone={save.loadout[1] === build.id ? 'primary' : 'neutral'} onClick={() => assignSlot(1)}>Carry as 2</UiButton>
            </div>
            <p className="muted">Now carrying: {save.loadout.map((id) => save.armory.find((entry) => entry.id === id)?.name ?? '—').join(' · ')}</p>
          </Section>

          <label className="field-row bench-name">Name
            <input
              aria-label="Build name"
              value={build.name}
              onChange={(event) => commit({ ...build, name: event.target.value })}
            />
          </label>
        </div>

        {/* The bench: the weapon itself, the five slots on it, and what fits them. */}
        <div className="builder-column builder-bench">
          <Tabs
            label="Chassis"
            value={build.chassisId}
            options={weaponChassis.map((entry) => ({ id: entry.id, label: entry.label }))}
            onChange={(chassisId: WeaponChassisId) => commit({ ...build, chassisId, parts: {} })}
          />
          <WeaponPreview chassisId={build.chassisId} parts={build.parts} activeSlot={activeSlot} reducedMotion={reducedMotion} />
          <p className="bench-chassis muted">{chassis?.description}</p>

          <div className="slot-rail" role="group" aria-label="Attachment slots">
            {weaponPartSlots.map((slot) => {
              const fitted = partsForSlot(build.chassisId, slot).find((part) => part.id === fittedInSlot(slot));
              const stock = !build.parts[slot] || build.parts[slot] === partsForSlot(build.chassisId, slot)[0]?.id;
              return (
                <button
                  key={slot}
                  className={`slot-tile ${slot === activeSlot ? 'is-active' : ''} ${stock ? '' : 'is-fitted'}`}
                  aria-pressed={slot === activeSlot}
                  onClick={() => { setActiveSlot(slot); setPreviewPartId(null); }}
                >
                  <span className="slot-name">{slotLabels[slot]}</span>
                  <strong>{fitted?.label ?? '—'}</strong>
                </button>
              );
            })}
          </div>

          <div className="part-options" role="group" aria-label={`${slotLabels[activeSlot]} options`}>
            {slotOptions.map((part) => {
              const isFitted = fittedInSlot(activeSlot) === part.id;
              const effects = partEffects(build, activeSlot, part).slice(0, 3);
              return (
                <button
                  key={part.id}
                  className={`part-card ${isFitted ? 'is-fitted' : ''}`}
                  aria-pressed={isFitted}
                  onClick={() => setSlot(activeSlot, part.id)}
                  onMouseEnter={() => setPreviewPartId(part.id)}
                  onMouseLeave={() => setPreviewPartId(null)}
                  onFocus={() => setPreviewPartId(part.id)}
                  onBlur={() => setPreviewPartId(null)}
                >
                  <strong>{part.label}</strong>
                  <span className="part-copy">{part.description}</span>
                  <span className="part-effects">
                    {effects.length === 0
                      ? <em className="part-effect">No change</em>
                      : effects.map((effect) => (
                        <em key={effect.key} className={`part-effect ${effect.better ? 'is-better' : 'is-worse'}`}>
                          {effect.label} {signedPercent(effect.percent)}
                        </em>
                      ))}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="builder-column builder-stats">
          <Section title="Stats" meta={stats.pellets > 1 ? `${stats.pellets} pellets` : 'single shot'}>
            <dl className="stat-readout">
              {STAT_ROWS.map((row) => {
                const value = stats[row.key];
                const base = baseStats[row.key];
                const delta = value - base;
                const higherIsBetter = STAT_META[row.key].higherIsBetter;
                const better = higherIsBetter ? delta > 0 : delta < 0;
                const changed = Math.abs(delta) > base * 0.001;
                const preview = previewStats ? previewStats[row.key] : null;
                const fraction = (candidate: number) => Math.max(0, Math.min(1, candidate / row.max));
                // The segment a hovered part would add or take away, drawn between the
                // current value and the previewed one -- the whole point of a bench.
                const previewBetter = preview !== null && (higherIsBetter ? preview > value : preview < value);
                return (
                  <div key={row.key}>
                    <dt>{STAT_META[row.key].label}</dt>
                    <dd>
                      <span className="stat-value">{formatStat(row.key, value)}</span>
                      <span className={`stat-bar ${changed ? (better ? 'is-better' : 'is-worse') : ''}`}>
                        <i style={{ transform: `scaleX(${fraction(value)})` }} />
                        {preview !== null && Math.abs(preview - value) > base * 0.001 && (
                          <b
                            className={`stat-ghost ${previewBetter ? 'is-better' : 'is-worse'}`}
                            style={{
                              left: `${Math.min(fraction(value), fraction(preview)) * 100}%`,
                              width: `${Math.abs(fraction(preview) - fraction(value)) * 100}%`,
                            }}
                          />
                        )}
                      </span>
                      {changed && <span className={`stat-delta ${better ? 'is-better' : 'is-worse'}`}>{better ? '▲' : '▼'}</span>}
                    </dd>
                  </div>
                );
              })}
            </dl>
          </Section>
        </div>
      </div>
    </section>
  );
}
