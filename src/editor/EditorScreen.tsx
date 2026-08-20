import { useEffect, useMemo, useRef, useState } from 'react';
import type { RuntimeLevelV1, Vec3 } from '../contracts';
import { cookLevel } from '../content/defaultLevel';
import { DEFAULT_ENVIRONMENT_PRESET_ID } from '../content/migrations';
import { validateLevel } from '../content/schema';
import { Section, Tabs, Tooltip, UiButton } from '../ui/Primitives';
import { editorAssetCategories, editorAssetCatalogVersion, editorAssetItems, getEditorAssetItem } from './assetCatalogAdapter';
import { useEditorStore } from './editorStore';
import { EditorViewport } from './EditorViewport';
import { currentNavigationData, navigationSourceKey, type NavigationBake } from './navigationState';
import { exportProject, importProject, saveProjectDirectory } from './projectIO';

interface EditorScreenProps {
  onPlay: (level: RuntimeLevelV1) => void;
  onExit: () => void;
}

type HierarchyFilter = 'all' | 'collision' | 'visuals' | 'lights' | 'gameplay';

const hierarchyFilters = [
  { id: 'all', label: 'All' },
  { id: 'collision', label: 'Collision' },
  { id: 'visuals', label: 'Visuals' },
  { id: 'lights', label: 'Lights' },
  { id: 'gameplay', label: 'Gameplay' },
] as const satisfies readonly { id: HierarchyFilter; label: string }[];

export function EditorScreen({ onPlay, onExit }: EditorScreenProps) {
  const store = useEditorStore();
  const { document, selectedId, cameraMode, collisionProxiesVisible } = store;
  const fileRef = useRef<HTMLInputElement>(null);
  const [navigationBake, setNavigationBake] = useState<NavigationBake>();
  const [status, setStatus] = useState('Ready');
  const [statusTone, setStatusTone] = useState<'info' | 'error'>('info');
  const [baking, setBaking] = useState(false);
  const [assetSearch, setAssetSearch] = useState('');
  const [assetCategory, setAssetCategory] = useState('All');
  const [hierarchyFilter, setHierarchyFilter] = useState<HierarchyFilter>('all');
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const validation = useMemo(() => validateLevel(document), [document]);
  const navigationKey = useMemo(() => navigationSourceKey(document), [document.collision, document.offMeshLinks]);
  const navMeshData = currentNavigationData(navigationBake, navigationKey);
  const navigationStale = Boolean(navigationBake && !navMeshData);
  const selectedCollision = document.collision.find((item) => item.id === selectedId);
  const selectedVisual = document.visuals.find((item) => item.id === selectedId);
  const selectedLight = document.lights.find((item) => item.id === selectedId);
  const selectedSpawn = document.spawns.find((item) => item.id === selectedId);
  const selectedEncounter = document.encounters.find((item) => item.id === selectedId);
  const selectedLink = document.offMeshLinks.find((item) => item.id === selectedId);
  const selectedAsset = selectedVisual ? getEditorAssetItem(selectedVisual.assetId) : undefined;
  const hasSelection = Boolean(selectedCollision ?? selectedVisual ?? selectedLight ?? selectedSpawn ?? selectedEncounter ?? selectedLink);
  const selectionKind = selectedCollision ? 'Collision' : selectedVisual ? 'Visual' : selectedLight ? 'Light' : selectedSpawn ? 'Spawn' : selectedEncounter ? 'Encounter' : selectedLink ? 'AI link' : null;
  const filteredAssets = useMemo(() => {
    const query = assetSearch.trim().toLowerCase();
    return editorAssetItems.filter((item) => {
      if (assetCategory !== 'All' && item.category !== assetCategory) return false;
      return !query || `${item.label} ${item.id} ${item.definition.tags.join(' ')}`.toLowerCase().includes(query);
    });
  }, [assetCategory, assetSearch]);
  const showGroup = (group: HierarchyFilter) => hierarchyFilter === 'all' || hierarchyFilter === group;

  const report = (message: string, tone: 'info' | 'error' = 'info') => {
    setStatus(message);
    setStatusTone(tone);
  };

  useEffect(() => {
    if (navigationStale) report('Navigation changed · rebake required.', 'error');
  }, [navigationStale]);

  const bake = () => {
    if (validation.errors.length) {
      report('Fix validation errors before baking.', 'error');
      return;
    }
    setBaking(true);
    report('Baking navigation…');
    const worker = new Worker(new URL('./navmesh.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<{ success: boolean; navMeshData?: Uint8Array; error?: string }>) => {
      if (event.data.success && event.data.navMeshData) {
        setNavigationBake({ data: event.data.navMeshData, sourceKey: navigationKey });
        report(`Navmesh baked · ${event.data.navMeshData.byteLength.toLocaleString()} bytes`);
      } else report(`Bake failed: ${event.data.error ?? 'unknown error'}`, 'error');
      setBaking(false);
      worker.terminate();
    };
    worker.onerror = (event) => {
      report(`Bake failed: ${event.message}`, 'error');
      setBaking(false);
      worker.terminate();
    };
    worker.postMessage(document);
  };

  const play = () => {
    if (validation.errors.length) return report('Fix validation errors before playtesting.', 'error');
    onPlay({ ...cookLevel(document), navMeshData });
  };

  const select = (id: string) => {
    store.setSelected(id);
    setInspectorOpen(true);
  };

  const create = (label: string, action: () => void) => {
    action();
    report(`Created ${label}`);
    setInspectorOpen(true);
  };

  return (
    <main className={`editor-shell ${inspectorOpen ? 'inspector-open' : ''}`}>
      <header className="editor-header">
        <div className="editor-identity">
          <span className="logo-mark">F/</span>
          <strong>{document.name}</strong>
          <small>Gameplay editor</small>
        </div>
        <nav aria-label="Editor actions">
          <div className="toolbar-group" role="group" aria-label="History">
            <Tooltip hint="Step backward through document history"><UiButton onClick={store.undo} disabled={!store.past.length}>Undo</UiButton></Tooltip>
            <Tooltip hint="Step forward through document history"><UiButton onClick={store.redo} disabled={!store.future.length}>Redo</UiButton></Tooltip>
          </div>
          <div className="toolbar-group" role="group" aria-label="Viewport">
            <Tooltip hint="Switch between perspective and orthographic framing"><UiButton aria-label={`Camera mode: ${cameraMode}`} onClick={() => store.setCameraMode(cameraMode === 'perspective' ? 'orthographic' : 'perspective')}>{cameraMode}</UiButton></Tooltip>
            <Tooltip hint="Collision proxies are authoring-only and never render in play"><UiButton aria-pressed={collisionProxiesVisible} onClick={store.toggleCollisionProxies}>{collisionProxiesVisible ? 'Hide collision' : 'Show collision'}</UiButton></Tooltip>
          </div>
          <div className="toolbar-group" role="group" aria-label="Project">
            <UiButton onClick={() => fileRef.current?.click()}>Open</UiButton>
            <UiButton onClick={async () => {
              try {
                const saved = await saveProjectDirectory(document, navMeshData);
                if (!saved) await exportProject(document, navMeshData);
                report(saved ? 'Saved V2 project directory.' : 'Exported V2 project archive.');
              } catch (reason) { report(reason instanceof Error ? reason.message : String(reason), 'error'); }
            }}>Save</UiButton>
          </div>
          <div className="toolbar-group" role="group" aria-label="Run">
            <Tooltip hint="Cook the document and play it with the current navmesh"><UiButton tone="primary" onClick={play}>Play from here</UiButton></Tooltip>
            <UiButton onClick={onExit}>Exit</UiButton>
          </div>
        </nav>
        <input ref={fileRef} type="file" accept=".fpsproj,.json" hidden onChange={async (event) => {
          const file = event.target.files?.[0];
          if (!file) return;
          try {
            const project = await importProject(file);
            store.replaceDocument(project.level);
            setNavigationBake(project.navMeshData
              ? { data: project.navMeshData, sourceKey: navigationSourceKey(project.level) }
              : undefined);
            report(`Opened ${file.name} · schema V${project.level.schemaVersion}`);
          } catch (reason) { report(reason instanceof Error ? reason.message : String(reason), 'error'); }
          event.target.value = '';
        }} />
      </header>

      <aside className="editor-palette panel" aria-label="Creation and hierarchy">
        <Section title="Create gameplay" meta={`${document.collision.length + document.visuals.length + document.lights.length}`}>
          <p className="group-label">Geometry</p>
          <div className="button-grid">
            <UiButton onClick={() => create('box', () => store.addPrimitive('box'))}>Box</UiButton>
            <UiButton onClick={() => create('ramp', () => store.addPrimitive('ramp'))}>Ramp</UiButton>
          </div>
          <p className="group-label">Actors &amp; flow</p>
          <div className="button-grid">
            <UiButton onClick={() => create('ranged bot', () => store.addSpawn('bot-ranged'))}>Ranged bot</UiButton>
            <UiButton onClick={() => create('aggressive bot', () => store.addSpawn('bot-aggressive'))}>Aggressive bot</UiButton>
            <UiButton onClick={() => create('bulwark bot', () => store.addSpawn('bot-bulwark'))}>Bulwark bot</UiButton>
            <UiButton onClick={() => create('encounter', store.addEncounter)}>Encounter</UiButton>
            <UiButton onClick={() => create('AI link', store.addOffMeshLink)}>AI link</UiButton>
          </div>
          <p className="group-label">Lighting</p>
          <div className="button-grid">
            <UiButton onClick={() => create('point light', () => store.addLight('point'))}>Point light</UiButton>
            <UiButton onClick={() => create('spot light', () => store.addLight('spot'))}>Spot light</UiButton>
          </div>
        </Section>

        <Section title="Visual assets" meta={`${filteredAssets.length}/${editorAssetItems.length}`}>
          <div className="asset-filters">
            <label className="field-row">Search<input aria-label="Search assets" type="search" value={assetSearch} placeholder="panel, traversal…" onChange={(event) => setAssetSearch(event.target.value)} /></label>
            <label className="field-row">Category<select aria-label="Asset category" value={assetCategory} onChange={(event) => setAssetCategory(event.target.value)}>{editorAssetCategories.map((category) => <option value={category} key={category}>{category}</option>)}</select></label>
          </div>
          <div className="scene-list asset-palette" aria-label="Curated asset catalog">
            {filteredAssets.map((item) => <button aria-label={`Place ${item.label}`} onClick={() => {
              store.addVisual(item.id, { assetCatalogVersion: editorAssetCatalogVersion, defaultScale: item.definition.scale });
              report(`Placed ${item.label}`);
            }} key={item.id}><i className="visual-dot" />{item.label}<small>{item.category}</small></button>)}
            {!filteredAssets.length && <p className="muted">No curated assets match this filter.</p>}
          </div>
        </Section>

        <Section title="Scene" meta={`${document.collision.length + document.visuals.length + document.lights.length + document.spawns.length + document.encounters.length + document.offMeshLinks.length}`}>
          <Tabs label="Hierarchy filter" value={hierarchyFilter} options={hierarchyFilters} onChange={setHierarchyFilter} />
          <div className="scene-list" aria-label="Scene hierarchy">
            {showGroup('collision') && document.collision.map((item) => <button className={item.id === selectedId ? 'selected' : ''} onClick={() => select(item.id)} key={item.id}><i style={{ background: item.color }} />{item.id}</button>)}
            {showGroup('visuals') && document.visuals.map((item) => <button className={item.id === selectedId ? 'selected' : ''} onClick={() => select(item.id)} key={item.id}><i className="visual-dot" />{getEditorAssetItem(item.assetId)?.label ?? item.assetId}<small>{item.id}</small></button>)}
            {showGroup('lights') && document.lights.map((item) => <button className={item.id === selectedId ? 'selected' : ''} onClick={() => select(item.id)} key={item.id}><i style={{ background: item.color }} />{item.id}</button>)}
            {showGroup('gameplay') && document.spawns.map((item) => <button className={item.id === selectedId ? 'selected' : ''} onClick={() => select(item.id)} key={item.id}><i className="spawn-dot" />{item.id}</button>)}
            {showGroup('gameplay') && document.encounters.map((item) => <button className={item.id === selectedId ? 'selected' : ''} onClick={() => select(item.id)} key={item.id}><i className="encounter-dot" />{item.label}</button>)}
            {showGroup('gameplay') && document.offMeshLinks.map((item) => <button className={item.id === selectedId ? 'selected' : ''} onClick={() => select(item.id)} key={item.id}><i className="link-dot" />{item.id}</button>)}
          </div>
        </Section>
      </aside>

      <section className="editor-viewport">
        <EditorViewport document={document} selectedId={selectedId} cameraMode={cameraMode} collisionProxiesVisible={collisionProxiesVisible} />
        <UiButton className="inspector-toggle" tone="ghost" aria-expanded={inspectorOpen} onClick={() => setInspectorOpen((open) => !open)}>{inspectorOpen ? 'Hide inspector' : 'Inspector'}</UiButton>
      </section>

      <aside className="editor-inspector panel" aria-label="Inspector">
        <div className="inspector-heading">
          <p className="panel-title">Inspector</p>
          {selectionKind && <span className="selection-kind">{selectionKind}</span>}
        </div>
        {!hasSelection && <p className="muted">Select collision, visual art, lighting, or a gameplay marker.</p>}

        {selectedCollision && <Section title="Collision proxy" meta={selectedCollision.surface}>
          <h3>{selectedCollision.id}</h3>
          <p className="muted">Collision proxy · visual art remains independent</p>
          <VectorFields label="Position" value={selectedCollision.transform.position} onChange={(position) => store.updateCollision(selectedCollision.id, { transform: { ...selectedCollision.transform, position } })} />
          <VectorFields label="Rotation" value={selectedCollision.transform.rotation} step={0.1} onChange={(rotation) => store.updateCollision(selectedCollision.id, { transform: { ...selectedCollision.transform, rotation } })} />
          <VectorFields label="Scale" value={selectedCollision.transform.scale} onChange={(scale) => store.updateCollision(selectedCollision.id, { transform: { ...selectedCollision.transform, scale } })} />
          <label>Surface<select value={selectedCollision.surface} onChange={(event) => store.setSurface(selectedCollision.id, event.target.value as typeof selectedCollision.surface)}>
            <option value="default">Default</option><option value="wall-run">Wall run</option><option value="vault">Vault</option><option value="mantle">Mantle</option><option value="no-traverse">No traverse</option>
          </select></label>
          <label>Encounter gate<select value={selectedCollision.gateForEncounterId ?? ''} onChange={(event) => store.updateCollision(selectedCollision.id, { gateForEncounterId: event.target.value || undefined })}>
            <option value="">None</option>{document.encounters.map((encounter) => <option value={encounter.id} key={encounter.id}>{encounter.label}</option>)}
          </select></label>
          <label>Proxy colour<input type="color" value={selectedCollision.color} onChange={(event) => store.updateCollision(selectedCollision.id, { color: event.target.value })} /></label>
          <label className="checkbox-row"><input type="checkbox" checked={selectedCollision.collision} onChange={(event) => store.updateCollision(selectedCollision.id, { collision: event.target.checked })} />Collision enabled</label>
          <fieldset className="bot-assignment"><legend>Traversal</legend>{(['wallRun', 'vault', 'mantle', 'grapple'] as const).map((flag) => <label key={flag}><input type="checkbox" checked={selectedCollision.traversal[flag]} onChange={(event) => store.updateCollision(selectedCollision.id, { traversal: { ...selectedCollision.traversal, [flag]: event.target.checked } })} />{readable(flag)}</label>)}</fieldset>
          <fieldset className="bot-assignment"><legend>Navigation</legend><label><input type="checkbox" checked={selectedCollision.nav.includeInBake} onChange={(event) => store.updateCollision(selectedCollision.id, { nav: { ...selectedCollision.nav, includeInBake: event.target.checked } })} />Include in bake</label><label><input type="checkbox" checked={selectedCollision.nav.walkable} onChange={(event) => store.updateCollision(selectedCollision.id, { nav: { ...selectedCollision.nav, walkable: event.target.checked } })} />Walkable</label></fieldset>
        </Section>}

        {selectedVisual && <Section title="Visual instance" meta={selectedAsset?.category}>
          <h3>{selectedVisual.id}</h3>
          <p className="muted">{selectedAsset?.label ?? selectedVisual.assetId} · visual instance</p>
          <label>Asset<select value={selectedVisual.assetId} onChange={(event) => store.updateVisual(selectedVisual.id, { assetId: event.target.value, materialVariantId: undefined })}>{editorAssetItems.map((item) => <option value={item.id} key={item.id}>{item.label}</option>)}</select></label>
          <VectorFields label="Position" value={selectedVisual.transform.position} onChange={(position) => store.updateVisual(selectedVisual.id, { transform: { ...selectedVisual.transform, position } })} />
          <VectorFields label="Rotation" value={selectedVisual.transform.rotation} step={0.1} onChange={(rotation) => store.updateVisual(selectedVisual.id, { transform: { ...selectedVisual.transform, rotation } })} />
          <VectorFields label="Scale" value={selectedVisual.transform.scale} onChange={(scale) => store.updateVisual(selectedVisual.id, { transform: { ...selectedVisual.transform, scale } })} />
          <label>Material variant<select value={selectedVisual.materialVariantId === 'base' ? '' : selectedVisual.materialVariantId ?? ''} onChange={(event) => store.updateVisual(selectedVisual.id, { materialVariantId: event.target.value || undefined })}>
            <option value="">Base</option>{selectedAsset?.variants.filter((variant) => variant.id !== 'base').map((variant) => <option value={variant.id} key={variant.id}>{variant.label}</option>)}
          </select></label>
          <label>Align to collision<select value={selectedVisual.collisionAlignmentId ?? ''} onChange={(event) => store.updateVisual(selectedVisual.id, { collisionAlignmentId: event.target.value || undefined })}>
            <option value="">Unbound</option>{document.collision.map((collision) => <option value={collision.id} key={collision.id}>{collision.id}</option>)}
          </select></label>
          {selectedVisual.collisionAlignmentId && <UiButton onClick={() => {
            const collision = document.collision.find((item) => item.id === selectedVisual.collisionAlignmentId);
            if (collision) store.updateVisual(selectedVisual.id, { transform: structuredClone(collision.transform) });
          }}>Snap to collision proxy</UiButton>}
          <label>Gate visibility<select value={selectedVisual.gateVisibilityBindingId ?? ''} onChange={(event) => store.updateVisual(selectedVisual.id, { gateVisibilityBindingId: event.target.value || undefined })}>
            <option value="">Always visible</option>{document.encounters.map((encounter) => <option value={encounter.id} key={encounter.id}>{encounter.label}</option>)}
          </select></label>
          <label className="checkbox-row"><input type="checkbox" checked={selectedVisual.castShadow} onChange={(event) => store.updateVisual(selectedVisual.id, { castShadow: event.target.checked })} />Cast shadow</label>
          <label className="checkbox-row"><input type="checkbox" checked={selectedVisual.receiveShadow} onChange={(event) => store.updateVisual(selectedVisual.id, { receiveShadow: event.target.checked })} />Receive shadow</label>
        </Section>}

        {selectedLight && <Section title="Light" meta={selectedLight.kind}>
          <h3>{selectedLight.id}</h3>
          <label>Type<select value={selectedLight.kind} onChange={(event) => store.updateLight(selectedLight.id, { kind: event.target.value as typeof selectedLight.kind })}><option value="point">Point</option><option value="spot">Spot</option></select></label>
          <VectorFields label="Position" value={selectedLight.transform.position} onChange={(position) => store.updateLight(selectedLight.id, { transform: { ...selectedLight.transform, position } })} />
          <VectorFields label="Rotation" value={selectedLight.transform.rotation} step={0.1} onChange={(rotation) => store.updateLight(selectedLight.id, { transform: { ...selectedLight.transform, rotation } })} />
          <label>Color<input type="color" value={selectedLight.color} onChange={(event) => store.updateLight(selectedLight.id, { color: event.target.value })} /></label>
          <NumberField label="Intensity" value={selectedLight.intensity} step={0.5} min={0} onChange={(intensity) => store.updateLight(selectedLight.id, { intensity })} />
          <NumberField label="Range" value={selectedLight.range} step={0.5} min={0.1} onChange={(range) => store.updateLight(selectedLight.id, { range })} />
          {selectedLight.kind === 'spot' && <><NumberField label="Cone angle" value={selectedLight.coneAngle ?? Math.PI / 4} step={0.05} min={0.05} max={Math.PI / 2} onChange={(coneAngle) => store.updateLight(selectedLight.id, { coneAngle })} /><NumberField label="Penumbra" value={selectedLight.penumbra ?? 0.35} step={0.05} min={0} max={1} onChange={(penumbra) => store.updateLight(selectedLight.id, { penumbra })} /></>}
          <label>Gate visibility<select value={selectedLight.gateVisibilityBindingId ?? ''} onChange={(event) => store.updateLight(selectedLight.id, { gateVisibilityBindingId: event.target.value || undefined })}><option value="">Always on</option>{document.encounters.map((encounter) => <option value={encounter.id} key={encounter.id}>{encounter.label}</option>)}</select></label>
          <label className="checkbox-row"><input type="checkbox" checked={selectedLight.castShadow} onChange={(event) => store.updateLight(selectedLight.id, { castShadow: event.target.checked })} />Cast shadow</label>
        </Section>}

        {selectedSpawn && <Section title="Spawn" meta={selectedSpawn.kind}>
          <h3>{selectedSpawn.id}</h3>
          <VectorFields label="Position" value={selectedSpawn.position} onChange={(position) => store.updateSpawn(selectedSpawn.id, { position })} />
          <NumberField label="Yaw" value={selectedSpawn.rotationY} step={0.1} onChange={(rotationY) => store.updateSpawn(selectedSpawn.id, { rotationY })} />
          {/* Which wave of its room the hostile belongs to. Authorable here because a
              wave is level data, and a room's difficulty curve is the thing an author
              most wants to move without editing the file by hand. */}
          {selectedSpawn.kind !== 'player' && (
            <NumberField
              label="Wave"
              value={selectedSpawn.wave ?? 0}
              step={1}
              onChange={(wave) => store.updateSpawn(selectedSpawn.id, { wave: Math.max(0, Math.round(wave)) || undefined })}
            />
          )}
          {selectedSpawn.kind !== 'player' && <label>Encounter<select value={selectedSpawn.encounterId ?? ''} onChange={(event) => store.assignSpawnEncounter(selectedSpawn.id, event.target.value || undefined)}>
            <option value="">Unassigned</option>{document.encounters.map((encounter) => <option value={encounter.id} key={encounter.id}>{encounter.label}</option>)}
          </select></label>}
        </Section>}

        {selectedEncounter && <Section title="Encounter" meta={`${selectedEncounter.requiredBotIds.length} bots`}>
          <h3>{selectedEncounter.id}</h3>
          <label>Label<input value={selectedEncounter.label} onChange={(event) => store.updateEncounter(selectedEncounter.id, { label: event.target.value })} /></label>
          <VectorFields label="Checkpoint" value={selectedEncounter.checkpoint} onChange={(checkpoint) => store.updateEncounter(selectedEncounter.id, { checkpoint })} />
          <fieldset className="bot-assignment"><legend>Required bots</legend>{document.spawns.filter((spawn) => spawn.kind !== 'player').map((spawn) => <label key={spawn.id}><input type="checkbox" checked={selectedEncounter.requiredBotIds.includes(spawn.id)} onChange={(event) => store.assignSpawnEncounter(spawn.id, event.target.checked ? selectedEncounter.id : undefined)} />{spawn.id}</label>)}</fieldset>
        </Section>}

        {selectedLink && <Section title="AI link" meta={selectedLink.action}>
          <h3>{selectedLink.id}</h3>
          <VectorFields label="Start" value={selectedLink.start} onChange={(start) => store.updateOffMeshLink(selectedLink.id, { start })} />
          <VectorFields label="End" value={selectedLink.end} onChange={(end) => store.updateOffMeshLink(selectedLink.id, { end })} />
          <label>Action<select value={selectedLink.action} onChange={(event) => store.updateOffMeshLink(selectedLink.id, { action: event.target.value as typeof selectedLink.action })}><option value="jump">Jump</option><option value="vault">Vault</option><option value="drop">Drop</option></select></label>
          <label className="checkbox-row"><input type="checkbox" checked={selectedLink.bidirectional} onChange={(event) => store.updateOffMeshLink(selectedLink.id, { bidirectional: event.target.checked })} />Bidirectional</label>
        </Section>}

        {selectedId && <div className="inspector-actions">{(selectedCollision || selectedVisual || selectedLight || (selectedSpawn && selectedSpawn.kind !== 'player')) && <UiButton onClick={store.duplicateSelected}>Duplicate</UiButton>}{selectedSpawn?.kind !== 'player' && <UiButton tone="danger" onClick={store.deleteSelected}>Delete</UiButton>}</div>}

        <Section title="World" meta={document.environmentPresetId} defaultOpen={false}>
          <label>Environment preset<select value={document.environmentPresetId} onChange={(event) => store.setEnvironmentPreset(event.target.value)}><option value={DEFAULT_ENVIRONMENT_PRESET_ID}>Cyber Dusk</option></select></label>
          <p className="muted">Asset catalog {document.assetCatalogVersion || editorAssetCatalogVersion}</p>
        </Section>

        <Section title="Build" meta={validation.errors.length ? `${validation.errors.length} errors` : navMeshData ? 'baked' : 'unbaked'}>
          <UiButton onClick={bake} disabled={baking || !!validation.errors.length}>{baking ? 'Baking…' : 'Bake navmesh'}</UiButton>
          {!!validation.errors.length && <div className="validation-block" role="alert">
            <p className="validation-heading">{validation.errors.length} blocking {validation.errors.length === 1 ? 'error' : 'errors'}</p>
            <ul className="validation-errors">{validation.errors.map((error) => <li key={error}>{error}</li>)}</ul>
          </div>}
          <p className={`editor-status ${statusTone === 'error' ? 'is-error' : ''}`} role="status">{status}</p>
          <p className="editor-help">W translate · E rotate · R scale · collision proxies are authoring-only</p>
        </Section>
      </aside>

      <footer className="editor-statusbar" aria-label="Editor status">
        <span><b>Collision</b>{document.collision.length}</span>
        <span><b>Visuals</b>{document.visuals.length}</span>
        <span><b>Lights</b>{document.lights.length}</span>
        <span><b>Spawns</b>{document.spawns.length}</span>
        <span><b>Camera</b>{cameraMode}</span>
        <span className={navigationStale ? 'is-warning' : ''}><b>Navmesh</b>{navigationStale ? 'stale' : navMeshData ? `${navMeshData.byteLength.toLocaleString()} B` : 'unbaked'}</span>
        <span className={validation.errors.length ? 'is-error' : 'is-ok'}><b>Validation</b>{validation.errors.length ? `${validation.errors.length} errors` : 'clean'}</span>
        <span className="statusbar-selection"><b>Selected</b>{hasSelection ? `${selectionKind} · ${selectedId}` : 'none'}</span>
      </footer>
    </main>
  );
}

function VectorFields({ label, value, onChange, step = 0.25 }: { label: string; value: Vec3; onChange: (value: Vec3) => void; step?: number }) {
  return <fieldset><legend>{label}</legend>{value.map((component, index) => <input aria-label={`${label} ${['X', 'Y', 'Z'][index]}`} key={index} type="number" step={step} value={Number(component.toFixed(3))} onChange={(event) => {
    const next = [...value] as unknown as [number, number, number];
    next[index] = Number(event.target.value);
    onChange(next);
  }} />)}</fieldset>;
}

function NumberField({ label, value, onChange, step, min, max }: { label: string; value: number; onChange: (value: number) => void; step?: number; min?: number; max?: number }) {
  return <label>{label}<input aria-label={label} type="number" value={Number(value.toFixed(3))} step={step} min={min} max={max} onChange={(event) => onChange(Number(event.target.value))} /></label>;
}

function readable(value: string): string {
  return value.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (letter) => letter.toUpperCase());
}
