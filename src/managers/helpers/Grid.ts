import * as THREE from "three";

export class Grid extends THREE.Object3D {
	private majorStep: number;
	private gridSize: number;
	private fadeDistance: number;

	constructor(
		_camera: THREE.Camera,
		gridSize: number = 1000,
		majorStep: number = 8,

		_minorStep: number = 1,
		majorColor: number = 0xaaaaaa,

		_minorColor: number = 0x666666,
		fadeDistance: number = 100 // Distance at which grid starts fading
	) {
		super();
		this.gridSize = gridSize;
		this.majorStep = majorStep;
		this.fadeDistance = fadeDistance;

		this.add(this.createGridLines(majorStep, majorColor));
	}

	private createGridLines(step: number, color: number): THREE.LineSegments {
		// Create custom shader material for distance-based opacity
		const material = new THREE.ShaderMaterial({
			uniforms: {
				color: { value: new THREE.Color(color) },
				opacity: { value: step === this.majorStep ? 1.0 : 0.5 },
				fadeDistance: { value: this.fadeDistance },
			},
			vertexShader: `
                varying vec3 vPosition;
                void main() {
                    vPosition = position;
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                }
            `,
			fragmentShader: `
                uniform vec3 color;
                uniform float opacity;
                uniform float fadeDistance;
                varying vec3 vPosition;

                void main() {
                    float dist = length(vPosition);
                    float fadeStart = fadeDistance * 0.5;
                    float fadeEnd = fadeDistance;
                    
                    // Calculate fade factor
                    float fadeFactor = 1.0 - smoothstep(fadeStart, fadeEnd, dist);
                    
                    // Add subtle pulse effect based on distance
                    float pulse = sin(dist * 0.05) * 0.1 + 0.9;
                    
                    gl_FragColor = vec4(color, opacity * fadeFactor * pulse);
                }
            `,
			transparent: true,
			side: THREE.DoubleSide,
		});

		const vertices: number[] = [];

		// Create grid with varying density
		for (let i = 0; i <= this.gridSize; i += step) {
			vertices.push(i, 0, -this.gridSize);
			vertices.push(i, 0, this.gridSize);
			vertices.push(-this.gridSize, 0, i);
			vertices.push(this.gridSize, 0, i);

			vertices.push(-i, 0, -this.gridSize);
			vertices.push(-i, 0, this.gridSize);
			vertices.push(-this.gridSize, 0, -i);
			vertices.push(this.gridSize, 0, -i);
		}

		const geometry = new THREE.BufferGeometry();
		geometry.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));

		return new THREE.LineSegments(geometry, material);
	}

	public update() {}
}
