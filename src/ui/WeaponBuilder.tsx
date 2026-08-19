import { useMemo, useState } from 'react';
import type { SaveDataV4, WeaponBuild, WeaponChassisId, WeaponDefinition, WeaponPartSlot } from '../contracts';
import { getWeaponChassis, partsForSlot, resolveWeaponStats, weaponChassis, weaponPartSlots } from '../content/weapons';
import { Section, Tabs, Tooltip, UiButton } from './Primitives';

interface WeaponBuilderProps {
  save: SaveDataV4;
  onChange: (next: SaveDataV4) => void;
  onClose: () => void;
  /** Shown when the builder is open mid-run, where changes wait for a respawn. */
  deferredNotice?: boolean;
}

/** Readout rows, with the value range each bar is drawn against. */
const STAT_ROWS = [
  { key: 'damage', label: 'Damage', max: 90, higherIsBetter: true },
  { key: 'roundsPerMinute', label: 'Rate of fire', max: 1200, higherIsBetter: true },
  { key: 'magazineSize', label: 'Magazine', max: 90, higherIsBetter: true },
  { key: 'range', label: 'Range', max: 260, higherIsBetter: true },
  { key: 'reloadSeconds', label: 'Reload', max: 3.2, higherIsBetter: false },
  { key: 'adsSpread', label: 'Aimed spread', max: 0.05, higherIsBetter: false },
  { key: 'hipSpread', label: 'Hip spread', max: 0.12, higherIsBetter: false },
] as const satisfies readonly { key: keyof WeaponDefinition; label: string; max: number; higherIsBetter: boolean }[];

const slotLabels: Record<WeaponPartSlot, string> = {
  optic: 'Optic',
  barrel: 'Barrel',
  magazine: 'Magazine',
  grip: 'Grip',
  stock: 'Stock',
};

function formatStat(key: keyof WeaponDefinition, value: number): string {
  if (key === 'adsSpread' || key === 'hipSpread') return value.toFixed(4);
  if (key === 'reloadSeconds') return `${value.toFixed(2)} s`;
  return String(Math.round(value));
}

export function WeaponBuilder({ save, onChange, onClose, deferredNotice = false }: WeaponBuilderProps) {
  const [editingId, setEditingId] = useState(() => save.loadout[0] ?? save.armory[0]?.id ?? '');
  const build = save.armory.find((entry) => entry.id === editingId) ?? save.armory[0];
  const stats = useMemo(() => (build ? resolveWeaponStats(build) : null), [build]);
  const baseStats = useMemo(() => (build ? getWeaponChassis(build.chassisId)?.base ?? null : null), [build]);

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

  return (
    <section className="weapon-builder" aria-label="Weapon builder">
      <header className="builder-header">
        <div>
          <p className="eyebrow">Gun builder</p>
          <h2>{build.name}</h2>
        </div>
        <UiButton onClick={onClose}>Done</UiButton>
      </header>

      {deferredNotice && <p className="builder-notice" role="status">Changes apply at your next checkpoint respawn.</p>}

      <div className="builder-body">
        <div className="builder-column">
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

          <Section title="Loadout" meta={loadoutIndex >= 0 ? `Slot ${loadoutIndex + 1}` : 'Not carried'}>
            <p className="muted">Two builds are carried into a run.</p>
            <div className="builder-actions">
              <UiButton tone={save.loadout[0] === build.id ? 'primary' : 'neutral'} onClick={() => assignSlot(0)}>Carry as 1</UiButton>
              <UiButton tone={save.loadout[1] === build.id ? 'primary' : 'neutral'} onClick={() => assignSlot(1)}>Carry as 2</UiButton>
            </div>
            <p className="muted">Now carrying: {save.loadout.map((id) => save.armory.find((entry) => entry.id === id)?.name ?? '—').join(' · ')}</p>
          </Section>
        </div>

        <div className="builder-column">
          <Section title="Chassis" meta={getWeaponChassis(build.chassisId)?.label}>
            <label className="field-row">Name
              <input
                aria-label="Build name"
                value={build.name}
                onChange={(event) => commit({ ...build, name: event.target.value })}
              />
            </label>
            <Tabs
              label="Chassis"
              value={build.chassisId}
              options={weaponChassis.map((chassis) => ({ id: chassis.id, label: chassis.label }))}
              onChange={(chassisId: WeaponChassisId) => commit({ ...build, chassisId, parts: {} })}
            />
            <p className="muted">{getWeaponChassis(build.chassisId)?.description}</p>
          </Section>

          <Section title="Parts">
            {weaponPartSlots.map((slot) => (
              <label className="field-row" key={slot}>{slotLabels[slot]}
                <select
                  aria-label={slotLabels[slot]}
                  value={build.parts[slot] ?? partsForSlot(build.chassisId, slot)[0]?.id ?? ''}
                  onChange={(event) => setSlot(slot, event.target.value)}
                >
                  {partsForSlot(build.chassisId, slot).map((part) => (
                    <option value={part.id} key={part.id}>{part.label}</option>
                  ))}
                </select>
              </label>
            ))}
            <p className="muted">
              {partsForSlot(build.chassisId, 'optic').find((part) => part.id === build.parts.optic)?.description ?? 'Fit parts to trade handling against reach and capacity.'}
            </p>
          </Section>
        </div>

        <div className="builder-column">
          <Section title="Stats" meta={`${stats.pellets > 1 ? `${stats.pellets} pellets` : 'single shot'}`}>
            <dl className="stat-readout">
              {STAT_ROWS.map((row) => {
                const value = stats[row.key] as number;
                const base = baseStats[row.key] as number;
                const delta = value - base;
                const better = row.higherIsBetter ? delta > 0 : delta < 0;
                const changed = Math.abs(delta) > base * 0.001;
                return (
                  <div key={row.key}>
                    <dt>{row.label}</dt>
                    <dd>
                      <span className="stat-value">{formatStat(row.key, value)}</span>
                      <span className={`stat-bar ${changed ? (better ? 'is-better' : 'is-worse') : ''}`}>
                        <i style={{ transform: `scaleX(${Math.min(1, value / row.max)})` }} />
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
