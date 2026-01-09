import * as THREE from 'three';
import { Snake } from './snake.js';
import { FoodManager } from './food-manager.js';
import { AudioManager } from './audio-manager.js';
import { ReplayRecorder } from './replay-recorder.js';
import { hideLoader } from './loader.js';
import { getRippleHeight, getIslandHeight, getRandomPointOnSphere } from './math-utils.js';

export class Game {
    constructor(scene, camera, renderer) {
        this.scene = scene;
        this.camera = camera;
        this.renderer = renderer;
        
        // Constants
        this.BASE_RADIUS = 10;
        this.earthRadius = this.BASE_RADIUS;
        
        // State
        this.isPlaying = false;
        this.isGameOver = false;
        this.score = 0;
        this.growthPoints = 0;
        this.time = 0;

        // Islands
        this.islands = []; // { pos: Vec3, maxRadius: float, currentRadius: float, progress: float, seed: float, maxHeight: float, currentHeight: float }
        this.lastIslandScore = 0;
        this.MAX_ISLANDS = 10;

        // Visuals
        this.rippleUniforms = {
            uTime: { value: 0 },
            uRippleCenters: { value: new Array(5).fill().map(() => new THREE.Vector3()) },
            uRippleStartTimes: { value: new Array(5).fill(-1000) },
            uRippleIntensities: { value: new Array(5).fill(0) },
            uEarthRadius: { value: this.BASE_RADIUS },
            uIslands: { value: new Array(10).fill().map(() => new THREE.Vector4(0,0,0,0)) }, // xyz = center, w = radius
            uIslandParams: { value: new Array(10).fill().map(() => new THREE.Vector2(0,0)) } // x = height, y = seed
        };
        this.currentRippleIdx = 0;
        
        // Player Info
        this.playerInfo = { username: 'Player', avatarUrl: '' };
        
        // Components
        this.audioManager = new AudioManager();
        this.recorder = new ReplayRecorder(30);
        
        // Entities
        this.earth = null;
        this.snake = null; // Replaces head, segments, pathHistory
        this.foodManager = null; // Replaces food, bonusFoods, spawn logic

        this.targetPoint = null;

        this.init();
    }

    setPlayerInfo(info) {
        this.playerInfo = info;
        const avatarEl = document.getElementById('player-avatar');
        const nameEl = document.getElementById('player-name');
        const playerCardEl = document.getElementById('player-card');

        // Always set name immediately if available
        if (nameEl && info.username) {
            nameEl.textContent = info.username;
        }

        // If we don't have an avatar element, nothing more to do
        if (!avatarEl) return;

        const fallbackUrl = './default_avatar.png';
        const primaryUrl = info.avatarUrl || fallbackUrl;

        const tryLoad = (urlList, index = 0) => {
            if (index >= urlList.length) {
                // No image could be loaded; leave card hidden
                return;
            }

            const url = urlList[index];
            const img = new Image();
            img.onload = () => {
                avatarEl.src = url;
                // Once avatar (or fallback) is ready, fade in the whole experience together
                document.body.classList.add('ready');
                hideLoader(); // Fade out loading screen
                if (playerCardEl) {
                    // Fade in avatar, username, and score together
                    playerCardEl.classList.add('visible');
                }
            };
            img.onerror = () => {
                // Try next URL in the list
                tryLoad(urlList, index + 1);
            };
            img.src = url;
        };

        // Prefer provided avatar, then fallback to default
        tryLoad([primaryUrl === fallbackUrl ? fallbackUrl : primaryUrl, fallbackUrl]);
    }

    init() {
        // removed loadSound calls - now in AudioManager

        this.audioManager.load('eat', './snake_eat.mp3');
        this.audioManager.load('die', './game_over.mp3');

        // Create Earth
        this.createEarth();

        // removed Snake Head creation - moved to Snake class
        this.snake = new Snake(this.scene, this.earthRadius);

        // removed Food creation/spawning - moved to FoodManager
        this.foodManager = new FoodManager(this.scene, this.earthRadius);
        this.foodManager.spawnFood(this.snake.head.position, this.snake.segments, this.earthRadius);

        this.resetGame();
    }
    
    createEarth() {
        const geometry = new THREE.SphereGeometry(this.BASE_RADIUS, 128, 128); // Higher detailed geo
        const material = new THREE.MeshStandardMaterial({
            color: 0x88ccff,
            emissive: 0x002244, 
            emissiveIntensity: 0.8,
            transparent: true,
            opacity: 0.9,
            roughness: 0.9,
            metalness: 0.0,
            side: THREE.DoubleSide
        });

        // Inject Custom Shader Logic (Ripples + Islands)
        material.onBeforeCompile = (shader) => {
            // Uniforms
            shader.uniforms.uTime = this.rippleUniforms.uTime;
            shader.uniforms.uRippleCenters = this.rippleUniforms.uRippleCenters;
            shader.uniforms.uRippleStartTimes = this.rippleUniforms.uRippleStartTimes;
            shader.uniforms.uRippleIntensities = this.rippleUniforms.uRippleIntensities;
            shader.uniforms.uEarthRadius = this.rippleUniforms.uEarthRadius;
            shader.uniforms.uIslands = this.rippleUniforms.uIslands;
            shader.uniforms.uIslandParams = this.rippleUniforms.uIslandParams;

            // Vertex Shader: Apply Displacement
            shader.vertexShader = shader.vertexShader.replace(
                '#include <common>',
                `#include <common>
                // Simplex Noise (Approximation)
                vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
                vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
                vec4 permute(vec4 x) { return mod289(((x*34.0)+1.0)*x); }
                vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
                float snoise(vec3 v) {
                    const vec2 C = vec2(1.0/6.0, 1.0/3.0);
                    const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
                    vec3 i  = floor(v + dot(v, C.yyy));
                    vec3 x0 = v - dot(i, C.xxx);
                    vec3 g = step(x0.yzx, x0.xyz);
                    vec3 l = 1.0 - g;
                    vec3 i1 = min( g.xyz, l.zxy );
                    vec3 i2 = max( g.xyz, l.zxy );
                    vec3 x1 = x0 - i1 + C.xxx;
                    vec3 x2 = x0 - i2 + C.yyy;
                    vec3 x3 = x0 - 1.0 + 3.0*C.xxx;
                    i = mod289(i);
                    vec4 p = permute( permute( permute( i.z + vec4(0.0, i1.z, i2.z, 1.0 )) + i.y + vec4(0.0, i1.y, i2.y, 1.0 )) + i.x + vec4(0.0, i1.x, i2.x, 1.0 ));
                    float n_ = 0.142857142857;
                    vec3  ns = n_ * D.wyz - D.xzx;
                    vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
                    vec4 x_ = floor(j * ns.z);
                    vec4 y_ = floor(j - 7.0 * x_ );
                    vec4 x = x_ *ns.x + ns.yyyy;
                    vec4 y = y_ *ns.x + ns.yyyy;
                    vec4 h = 1.0 - abs(x) - abs(y);
                    vec4 b0 = vec4( x.xy, y.xy );
                    vec4 b1 = vec4( x.zw, y.zw );
                    vec4 s0 = floor(b0)*2.0 + 1.0;
                    vec4 s1 = floor(b1)*2.0 + 1.0;
                    vec4 sh = -step(h, vec4(0.0));
                    vec4 a0 = b0.xzyw + s0.xzyw*sh.xxyy ;
                    vec4 a1 = b1.xzyw + s1.xzyw*sh.zzww ;
                    vec3 p0 = vec3(a0.xy,h.x);
                    vec3 p1 = vec3(a0.zw,h.y);
                    vec3 p2 = vec3(a1.xy,h.z);
                    vec3 p3 = vec3(a1.zw,h.w);
                    vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2, p2), dot(p3,p3)));
                    p0 *= norm.x;
                    p1 *= norm.y;
                    p2 *= norm.z;
                    p3 *= norm.w;
                    vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
                    m = m * m;
                    return 42.0 * dot( m*m, vec4( dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3) ) );
                }

                uniform float uEarthRadius;
                uniform vec4 uIslands[10];
                uniform vec2 uIslandParams[10]; // x = height, y = seed
                varying vec3 vWorldPos;
                varying float vHeight;
                
                float getIslandHeightVert(vec3 pos) {
                    float totalH = 0.0;
                    vec3 pNorm = normalize(pos);
                    for(int i=0; i<10; i++) {
                        if (uIslands[i].w <= 0.0) continue;
                        float dotProd = dot(pNorm, uIslands[i].xyz);
                        float angle = acos(clamp(dotProd, -1.0, 1.0));
                        float dist = angle * uEarthRadius;
                        
                        if (dist < uIslands[i].w) {
                            float shape = (cos((dist / uIslands[i].w) * 3.14159) + 1.0) * 0.5;
                            float noiseVal = snoise(pNorm * 2.0 + vec3(uIslandParams[i].y));
                            shape *= (1.0 + 0.5 * noiseVal);
                            
                            totalH += shape * uIslandParams[i].x; 
                        }
                    }
                    return totalH;
                }
                `
            );

            shader.vertexShader = shader.vertexShader.replace(
                '#include <worldpos_vertex>',
                `#include <worldpos_vertex>
                vWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
                float iHeight = getIslandHeightVert(vWorldPos);
                vHeight = iHeight;
                
                // Displace vertex
                vec3 norm = normalize(transformed);
                transformed = norm * (uEarthRadius + iHeight);
                `
            );

            // Fragment Shader: Colors
            shader.fragmentShader = shader.fragmentShader.replace(
                '#include <common>',
                `#include <common>
                uniform float uTime;
                uniform vec3 uRippleCenters[5];
                uniform float uRippleStartTimes[5];
                uniform float uRippleIntensities[5];
                uniform float uEarthRadius;
                varying vec3 vWorldPos;
                varying float vHeight;

                float getRipple(int i, vec3 pos) {
                    float startTime = uRippleStartTimes[i];
                    if (startTime < 0.0) return 0.0;
                    
                    float age = uTime - startTime;
                    if (age < 0.0 || age > 2.0) return 0.0; 
                    
                    vec3 center = uRippleCenters[i];
                    float intensity = uRippleIntensities[i];
                    
                    float dotProd = dot(normalize(pos), normalize(center));
                    float angle = acos(clamp(dotProd, -1.0, 1.0));
                    float dist = angle * uEarthRadius; 
                    
                    float speed = 8.0; 
                    float waveCenter = age * speed;
                    float distDiff = dist - waveCenter;
                    
                    float ripple = 0.0;
                    if (abs(distDiff) < 2.0) {
                        ripple = sin(distDiff * 3.0) * exp(-distDiff * distDiff);
                    }
                    ripple *= (1.0 - age / 2.0);
                    ripple *= intensity;
                    return ripple;
                }
                
                // Simple pseudo-random for noise
                float hash(vec2 p) {
                    return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
                }
                `
            );

            shader.fragmentShader = shader.fragmentShader.replace(
                '#include <dithering_fragment>',
                `#include <dithering_fragment>
                float totalRipple = 0.0;
                for(int i=0; i<5; i++) {
                    totalRipple += getRipple(i, vWorldPos);
                }
                
                // Base Color logic
                vec3 finalColor = gl_FragColor.rgb;
                
                // Islands
                if (vHeight > 0.01) {
                    float noise = hash(vWorldPos.xy * 10.0 + vWorldPos.zx * 5.0);
                    
                    if (vHeight < 0.3) {
                         // Beach / Sand
                         vec3 sand = vec3(0.95, 0.85, 0.5);
                         finalColor = mix(finalColor, sand, smoothstep(0.01, 0.1, vHeight));
                    } else {
                         // Grass
                         vec3 grass = vec3(0.2, 0.6, 0.1);
                         // Mix beach to grass
                         finalColor = mix(vec3(0.95, 0.85, 0.5), grass, smoothstep(0.3, 0.5, vHeight + noise*0.1));
                         // Add some texture
                         finalColor *= (0.9 + 0.2 * noise);
                    }
                }
                
                // Ripples
                if (abs(totalRipple) > 0.01) {
                    float strength = smoothstep(0.0, 0.5, abs(totalRipple));
                    vec3 rippleColor = vec3(0.7, 0.9, 1.0);
                    finalColor = mix(finalColor, rippleColor, strength * 0.4);
                    finalColor += rippleColor * strength * 0.2;
                }
                
                gl_FragColor.rgb = finalColor;
                `
            );
        };

        this.earth = new THREE.Mesh(geometry, material);
        this.scene.add(this.earth);
        
        const atmGeometry = new THREE.SphereGeometry(this.BASE_RADIUS * 1.03, 64, 64);
        const atmMaterial = new THREE.MeshBasicMaterial({
            color: 0x4488ff,
            transparent: true,
            opacity: 0.1,
            side: THREE.BackSide
        });
        this.scene.add(new THREE.Mesh(atmGeometry, atmMaterial));
    }
    
    resetGame() {
        this.earthRadius = this.BASE_RADIUS;
        this.islands = [];
        this.lastIslandScore = 0;
        this.rippleUniforms.uEarthRadius.value = this.BASE_RADIUS;
        this.rippleUniforms.uIslands.value.forEach(v => v.set(0,0,0,0));
        this.rippleUniforms.uIslandParams.value.forEach(v => v.set(0,0));
        
        if (this.earth) {
            this.earth.scale.set(1,1,1);
        }

        // removed reset logic for segments/bonus foods - delegated to managers
        this.snake.reset();
        this.foodManager.reset();
        this.foodManager.spawnFood(this.snake.head.position, this.snake.segments, this.earthRadius);
        
        this.recorder.reset();

        // Reset Visuals
        this.rippleUniforms.uRippleStartTimes.value.fill(-1000);
        
        // Reset Camera
        this.updateCamera(0.1, true); // Force snap
        
        this.score = 0;
        this.growthPoints = 0;
        this.isGameOver = false;
        this.isPlaying = true;
        this.targetPoint = null;

        const scoreEl = document.getElementById('player-score');
        if(scoreEl) scoreEl.innerText = this.score;
        
        const gameOverEl = document.getElementById('game-over');
        if (gameOverEl) {
            gameOverEl.classList.add('hidden');
            gameOverEl.classList.remove('visible');
        }
    }

    playSound(name, volume = 1.0) {
        this.audioManager.play(name, volume);
        this.recorder.recordEvent(name, { volume });
    }

    setTarget(point) {
        if(this.isGameOver) return;
        this.audioManager.resume();
        this.targetPoint = point.clone().normalize().multiplyScalar(this.earthRadius);
    }

    triggerRipple(point, durationMs) {
        const idx = this.currentRippleIdx;
        this.rippleUniforms.uRippleCenters.value[idx].copy(point);
        this.rippleUniforms.uRippleStartTimes.value[idx] = this.time;
        
        // Intensity logic based on hold duration
        // Short tap (<200ms) -> 0.15
        // Long tap (>600ms) -> 0.45
        let intensity = 0.15;
        if (durationMs > 200) {
            const factor = Math.min((durationMs - 200) / 400, 1.0);
            intensity = 0.15 + factor * 0.3;
        }
        
        this.rippleUniforms.uRippleIntensities.value[idx] = intensity;
        
        this.currentRippleIdx = (this.currentRippleIdx + 1) % 5;

        // Record for replay
        this.recorder.recordEvent('ripple', { 
            center: point.toArray(), 
            duration: durationMs 
        });
    }

    update(dt) {
        this.time += dt;
        this.rippleUniforms.uTime.value = this.time;

        if(this.isGameOver) return;

        // --- Growth & Islands Logic ---
        // 1. Grow Earth Radius
        const targetRadius = this.BASE_RADIUS + this.score * 0.05;
        this.earthRadius = THREE.MathUtils.lerp(this.earthRadius, targetRadius, dt * 0.5);
        
        // Scale the mesh so Raycaster hits the larger sphere
        // Shader uses uEarthRadius = 10.0 (BASE) for internal calculation relative to scale
        if (this.earth) {
            this.earth.scale.setScalar(this.earthRadius / this.BASE_RADIUS);
        }
        
        // NOTE: Shader uEarthRadius kept at BASE_RADIUS (10.0) because vertex positions are local in shader 
        // and mesh scale handles the world size.
        // But for island distribution logic in shader, it relies on angle * radius.
        // If we use 10.0, dist is "local arc length".
        this.rippleUniforms.uEarthRadius.value = this.BASE_RADIUS;

        // 2. Spawn Islands
        if (this.score >= this.lastIslandScore + 50 && this.islands.length < this.MAX_ISLANDS) {
            this.lastIslandScore += 50;
            const pos = getRandomPointOnSphere(1.0).normalize();
            this.islands.push({
                pos: pos,
                maxRadius: 2.5 + Math.random() * 2.0,
                maxHeight: 2.5 + Math.random() * 1.5,
                currentRadius: 0.0,
                currentHeight: 0.0,
                seed: Math.random() * 100.0,
                progress: 0.0
            });
        }

        // 3. Update Islands (Floating Up Animation)
        this.islands.forEach((island, i) => {
            if (island.progress < 1.0) {
                island.progress += dt * 0.15; // Grow slowly
                const t = Math.min(island.progress, 1.0);
                
                // Radius grows linearly
                island.currentRadius = island.maxRadius * t;
                
                // Height grows non-linearly to simulate "emerging"
                // Starts at 0, goes to maxHeight
                island.currentHeight = island.maxHeight * (t * t * (3 - 2 * t)); 
            }
            // Update Uniforms
            if (i < 10) {
                this.rippleUniforms.uIslands.value[i].set(island.pos.x, island.pos.y, island.pos.z, island.currentRadius);
                this.rippleUniforms.uIslandParams.value[i].set(island.currentHeight, island.seed);
            }
        });

        // 4. Terrain Function
        const terrainFn = (pos) => {
            const r = getRippleHeight(
                pos,
                this.time,
                this.rippleUniforms.uRippleCenters.value,
                this.rippleUniforms.uRippleStartTimes.value,
                this.rippleUniforms.uRippleIntensities.value,
                this.earthRadius
            );
            
            const islandH = getIslandHeight(
                pos,
                this.islands.map(i => ({ 
                    pos: i.pos, 
                    radius: i.currentRadius,
                    height: i.currentHeight,
                    seed: i.seed
                })),
                this.earthRadius
            );
            
            return r + islandH;
        };

        // 5. Update Snake
        const moveDist = this.snake.update(dt, this.targetPoint, terrainFn, this.earthRadius);
        if (moveDist > 0 && this.targetPoint && this.snake.head.position.distanceTo(this.targetPoint) < 1.0) {
            this.targetPoint = null;
        }

        // 6. Update Food Manager
        this.foodManager.update(moveDist, this.snake.getTailPosition(), terrainFn, this.earthRadius);

        // 7. Collision Checks
        const collisions = this.foodManager.checkCollisions(this.snake.head.position);
        
        if (collisions.mainFood) {
            this.playSound('eat', 0.33);
            this.score += 5;
            this.growthPoints += 5;
            
            const scoreEl = document.getElementById('player-score');
            if(scoreEl) scoreEl.innerText = this.score;
            
            this.foodManager.spawnFood(this.snake.head.position, this.snake.segments, this.earthRadius);
            
            if (Math.random() < 0.5) {
                this.foodManager.spawnBonusTrail(5);
            }

            // Give a nice tongue slither on big bites
            this.snake.triggerTongue();
        }
        
        // Sort indices descending to remove safely
        collisions.bonusIndices.sort((a,b) => b-a).forEach(idx => {
            this.playSound('eat', 0.33);
            this.score += 1;
            this.growthPoints += 1;
            const scoreEl = document.getElementById('player-score');
            if(scoreEl) scoreEl.innerText = this.score;
            this.foodManager.removeBonusFood(idx);

            // Flick tongue on snack-sized bonus foods
            this.snake.triggerTongue();
        });

        // Check Growth
        while (this.growthPoints >= 10) {
            this.snake.addSegment();
            this.growthPoints -= 10;
        }

        // 4. Check Self Collision
        // removed loop - delegated to Snake
        if (this.snake.checkSelfCollision()) {
            this.gameOver();
        }

        // 5. Update Camera
        this.updateCamera(dt);

        // 6. Record Frame
        // removed recordFrame implementation - delegated to ReplayRecorder
        this.recorder.update(dt, () => this.getSnapshot());
    }
    
    updateCamera(dt, snap = false) {
        const idealCameraPos = this.snake.head.position.clone().normalize().multiplyScalar(30);
        if (snap) {
            this.camera.position.copy(idealCameraPos);
        } else {
            this.camera.position.lerp(idealCameraPos, 2.0 * dt);
        }
        this.camera.lookAt(0, 0, 0);
        
        const snakeForward = new THREE.Vector3(0, 0, 1).applyQuaternion(this.snake.head.quaternion);
        this.camera.up.copy(snakeForward);
    }

    getSnapshot() {
        return {
            head: {
                pos: this.snake.head.position.toArray(),
                quat: this.snake.head.quaternion.toArray()
            },
            camera: {
                pos: this.camera.position.toArray(),
                quat: this.camera.quaternion.toArray(),
                up: this.camera.up.toArray()
            },
            food: this.foodManager.food.position.toArray(),
            bonusFoods: this.foodManager.bonusFoods.map(b => b.position.toArray()),
            segments: this.snake.segments.map(seg => ({
                pos: seg.position.toArray(),
                quat: seg.quaternion.toArray(),
                color: seg.material.color.getHex()
            })),
            score: this.score,
            tongue: {
                scaleX: this.snake.tongue ? this.snake.tongue.scale.x : 1,
                scaleZ: this.snake.tongue ? this.snake.tongue.scale.z : 0.01
            },
            env: {
                radius: this.earthRadius,
                islands: this.islands.map(i => ({
                    pos: i.pos.toArray(),
                    radius: i.currentRadius,
                    height: i.currentHeight,
                    seed: i.seed
                }))
            },
            events: [] // Filled by recorder
        };
    }

    getReplayJSON() {
        return this.recorder.getReplayJSON({
            earthRadius: this.earthRadius,
            fps: this.recorder.RECORD_FPS,
            playerInfo: this.playerInfo,
            sounds: {
                eat: './snake_eat.mp3',
                die: './game_over.mp3'
            },
            muted: this.audioManager.isMuted()
        });
    }

    gameOver() {
        this.isGameOver = true;
        this.playSound('die');
        // Force a final record
        this.recorder.update(100, () => this.getSnapshot()); 
        
        const gameOverEl = document.getElementById('game-over');
        const restartBtn = document.getElementById('btn-restart');
        const replayBtn = document.getElementById('btn-replay');

        // Disable buttons initially to prevent misclicks
        if (restartBtn) restartBtn.disabled = true;
        if (replayBtn) replayBtn.disabled = true;

        if (gameOverEl) {
            gameOverEl.classList.remove('hidden');
            // Allow display: none to clear before starting transition
            requestAnimationFrame(() => {
                gameOverEl.classList.add('visible');
            });

            // Re-enable buttons shortly after fade-in starts
            setTimeout(() => {
                if (restartBtn) restartBtn.disabled = false;
                if (replayBtn) replayBtn.disabled = false;
            }, 700);
        }
        this.isPlaying = false;
    }
}