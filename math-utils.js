import * as THREE from 'three';
import { createNoise3D } from 'simplex-noise';
import Alea from 'alea';

// Use a seeded random for consistent noise across replays if needed, 
// though visual noise for islands can be consistent just by coordinates.
const prng = new Alea('spherical-snake');
const noise3D = createNoise3D(prng);

/**
 * Projects a target point onto the tangent plane of the source point on a sphere.
 * Used to determine steering direction.
 */
export function getTangentDirection(sourcePos, targetPos, sphereCenter) {
    // Normal at source position
    const normal = new THREE.Vector3().subVectors(sourcePos, sphereCenter).normalize();
    
    // Vector from source to target
    const toTarget = new THREE.Vector3().subVectors(targetPos, sourcePos);
    
    // Project toTarget onto the plane defined by normal
    // v_proj = v - (v . n) * n
    const projection = toTarget.clone().sub(normal.clone().multiplyScalar(toTarget.dot(normal)));
    
    return projection.normalize();
}

/**
 * Returns a random point on the surface of a sphere of given radius.
 */
export function getRandomPointOnSphere(radius) {
    const u = Math.random();
    const v = Math.random();
    const theta = 2 * Math.PI * u;
    const phi = Math.acos(2 * v - 1);
    
    const x = radius * Math.sin(phi) * Math.cos(theta);
    const y = radius * Math.sin(phi) * Math.sin(theta);
    const z = radius * Math.cos(phi);
    
    return new THREE.Vector3(x, y, z);
}

/**
 * Calculates the ripple height offset at a specific position on the sphere.
 * Matches the logic in the Earth shader.
 */
export function getIslandHeight(pos, islands, earthRadius) {
    let totalH = 0.0;
    // Normalize position to get unit sphere coordinates for noise
    const pNorm = pos.clone().normalize();
    
    // Islands logic matches shader
    for(const island of islands) {
        if(island.radius <= 0) continue;
        
        const dot = pNorm.dot(island.pos); // island.pos is normalized center
        const angle = Math.acos(Math.max(-1.0, Math.min(1.0, dot)));
        const dist = angle * earthRadius;
        
        if (dist < island.radius) {
            // Base Cosine hill shape
            let shape = (Math.cos((dist / island.radius) * Math.PI) + 1.0) * 0.5;
            
            // Add noise for detail
            // Frequency 2.0, Amplitude 0.5 relative to height
            const n = noise3D(pNorm.x * 2.0 + (island.seed || 0), pNorm.y * 2.0, pNorm.z * 2.0);
            shape *= (1.0 + 0.5 * n);

            // Apply Island Height
            // If island.height is not defined, fallback to old radius-based height logic
            const heightScale = island.height !== undefined ? island.height : (island.radius * 0.4);
            
            totalH += shape * heightScale; 
        }
    }
    return totalH;
}

export function getRippleHeight(pos, time, centers, startTimes, intensities, earthRadius = 10.0) {
    let totalRipple = 0.0;
    // We need normalized vectors for dot product
    // pos is expected to be roughly on surface, but we normalize to be safe
    const pNorm = pos.clone().normalize();
    
    for(let i=0; i<5; i++) {
        const startTime = startTimes[i];
        if (startTime < 0.0) continue;
        
        const age = time - startTime;
        if (age < 0.0 || age > 2.0) continue;
        
        const center = centers[i]; // already a vector
        // center might not be normalized in storage, so normalize it
        const cNorm = center.clone().normalize();
        
        const dotProd = pNorm.dot(cNorm);
        const angle = Math.acos(Math.max(-1.0, Math.min(1.0, dotProd)));
        const dist = angle * earthRadius;
        
        const speed = 8.0; 
        const waveCenter = age * speed;
        const distDiff = dist - waveCenter;
        
        // Wave packet width
        if (Math.abs(distDiff) < 2.0) {
            let ripple = Math.sin(distDiff * 3.0) * Math.exp(-distDiff * distDiff);
            
            // Fade out
            ripple *= (1.0 - age / 2.0);
            ripple *= intensities[i];
            
            totalRipple += ripple;
        }
    }
    return totalRipple;
}