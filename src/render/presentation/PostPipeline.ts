import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { Pass } from 'three/examples/jsm/postprocessing/Pass.js';
import { TONE, toneCurveGlsl } from './toneCurve';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import type { SaveDataV1 } from '../../contracts';

type RuntimeQuality = 'low' | 'medium' | 'high';

class CombinedScenePass extends Pass {
  override needsSwap = false;
  override clear = true;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly camera: THREE.Camera,
    private readonly viewScene: THREE.Scene,
    private readonly viewCamera: THREE.Camera,
  ) {
    super();
  }

  override render(renderer: THREE.WebGLRenderer, _writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget): void {
    const previousAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(this.renderToScreen ? null : readBuffer);
    renderer.clear(true, true, true);
    renderer.render(this.scene, this.camera);
    renderer.clearDepth();
    renderer.render(this.viewScene, this.viewCamera);
    renderer.autoClear = previousAutoClear;
  }

  renderDirect(renderer: THREE.WebGLRenderer): void {
    renderer.setRenderTarget(null);
    renderer.clear(true, true, true);
    renderer.render(this.scene, this.camera);
    renderer.clearDepth();
    renderer.render(this.viewScene, this.viewCamera);
  }
}

/**
 * The whole of the image pipeline that is not lighting: the authored tone curve, the
 * palette, and the speed feedback, in one pass.
 *
 * Runs on the linear buffer before `OutputPass`, and it is the *only* curve in the stack
 * now -- `renderer.toneMapping` is `NoToneMapping`, so `OutputPass` does nothing but the
 * colour-space conversion. That is the change: this used to sit downstream of ACES and
 * spend most of its budget undoing it, which is why its own comment recorded that moving
 * it "washes the whole route out". See `toneCurve`.
 *
 * The speed effects stay folded in here because they cost no extra fullscreen pass, which
 * matters more than ever now that the phone profile caps the render target.
 */
const CyberDuskGrade = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    gradeStrength: { value: 0.78 },
    /** 0 at a standstill, 1 at the speed the effects are tuned to peak at. */
    speed: { value: 0 },
    streakStrength: { value: 1 },
  },
  vertexShader: 'varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform float gradeStrength;
    uniform float speed;
    uniform float streakStrength;
    varying vec2 vUv;
    ${toneCurveGlsl}
    void main(){
      vec2 centred=vUv-0.5;
      float radius=length(centred)*2.0;
      float drive=speed*streakStrength;
      // Radial smear, weakest at the crosshair so the target stays readable and
      // strongest at the edges where the world is rushing past.
      float smear=drive*smoothstep(0.25,1.0,radius);
      vec3 c=texture2D(tDiffuse,vUv).rgb;
      if(smear>0.001){
        vec3 streak=c;
        for(int i=1;i<4;i++){
          float step=float(i)/3.0*smear*0.055;
          streak+=texture2D(tDiffuse,vUv-centred*step).rgb;
        }
        c=streak*0.25;
        // Radial dispersion: the channels separate slightly at the frame edges.
        float split=smear*0.004;
        c.r=texture2D(tDiffuse,vUv-centred*split).r;
        c.b=texture2D(tDiffuse,vUv+centred*split).b;
      }
      // The curve. The strength uniform mixes it against the same scene at plain
      // exposure, so the low graphics profile gets a gentler statement of the palette
      // rather than a different one -- and so it can be turned off entirely to see what
      // the lighting actually produced.
      vec3 plain=clamp(c*${TONE.exposure.toFixed(4)},0.0,1.0);
      vec3 graded=mix(plain,flowstateTone(c),gradeStrength);
      // Closing the frame in at speed, which reads as tunnelling.
      graded*=1.0-drive*0.22*smoothstep(0.35,1.15,radius);
      gl_FragColor=vec4(graded,1.0);
    }
  `,
};

export class PostPipeline {
  private readonly composer: EffectComposer;
  private readonly combinedPass: CombinedScenePass;
  private readonly bloomPass: UnrealBloomPass;
  private readonly gradePass: ShaderPass;
  private readonly outputPass: OutputPass;
  private quality: RuntimeQuality;
  private reducedMotion: boolean;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
    viewScene: THREE.Scene,
    viewCamera: THREE.Camera,
    settings: SaveDataV1['settings'],
  ) {
    this.quality = this.resolveQuality(settings);
    this.reducedMotion = settings.reducedMotion;
    this.composer = new EffectComposer(renderer);
    this.combinedPass = new CombinedScenePass(scene, camera, viewScene, viewCamera);
    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.18, 0.38, 1.02);
    this.gradePass = new ShaderPass(CyberDuskGrade);
    this.outputPass = new OutputPass();
    this.composer.addPass(this.combinedPass);
    this.composer.addPass(this.bloomPass);
    this.composer.addPass(this.gradePass);
    this.composer.addPass(this.outputPass);
    this.updateSettings(settings);
  }

  updateSettings(settings: SaveDataV1['settings']): void {
    this.quality = this.resolveQuality(settings);
    this.reducedMotion = settings.reducedMotion;
    this.bloomPass.enabled = this.quality !== 'low';
    this.bloomPass.strength = this.reducedMotion ? 0.09 : this.quality === 'high' ? 0.22 : 0.15;
    this.bloomPass.radius = this.quality === 'high' ? 0.42 : 0.32;
    // Applied to linear values, so it has to stay near 1. Dropping it to 0.72 bloomed
    // every lit surface into a white-out, and even 0.96 washed the frame whenever an
    // emissive strip came close to the camera.
    this.bloomPass.threshold = 1.05;
    this.gradePass.uniforms.gradeStrength.value = this.quality === 'low' ? 0.72 : 1;
    // Reduced motion keeps the grade and drops only the motion cues.
    this.gradePass.uniforms.streakStrength.value = this.reducedMotion ? 0 : this.quality === 'high' ? 1 : 0.6;
  }

  /** Normalized 0..1. Drives the radial smear, dispersion and edge closing. */
  setSpeed(normalized: number): void {
    this.gradePass.uniforms.speed.value = Math.max(0, Math.min(1, normalized));
  }

  setSize(width: number, height: number, pixelRatio: number): void {
    this.composer.setPixelRatio(pixelRatio);
    this.composer.setSize(width, height);
  }

  render(deltaSeconds: number): void {
    this.renderer.info.reset();
    if (this.quality === 'low') {
      this.combinedPass.renderDirect(this.renderer);
      return;
    }
    this.composer.render(deltaSeconds);
  }

  dispose(): void {
    this.composer.dispose();
    this.bloomPass.dispose();
    this.gradePass.dispose();
    this.outputPass.dispose();
  }

  private resolveQuality(settings: SaveDataV1['settings']): RuntimeQuality {
    const requested = 'graphicsQuality' in settings ? settings.graphicsQuality : 'auto';
    if (requested === 'low') return 'low';
    if (requested === 'high') return 'high';
    if (requested === 'medium') return 'medium';
    const pixelBudget = window.innerWidth * window.innerHeight * window.devicePixelRatio ** 2;
    // A phone reports a small window at a large pixel ratio, so on pixel budget alone it
    // lands in the same bucket as a laptop and gets a laptop's post chain. The primary
    // pointer is the cheapest honest signal that the GPU behind it is a mobile one.
    if (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches) {
      return pixelBudget > 2_000_000 ? 'low' : 'medium';
    }
    return pixelBudget > 4_000_000 ? 'medium' : 'high';
  }
}
