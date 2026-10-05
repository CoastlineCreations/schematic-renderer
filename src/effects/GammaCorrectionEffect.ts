import { Effect, BlendFunction } from "postprocessing";
import { Uniform } from "three";

export class GammaCorrectionEffect extends Effect {
	private readonly gammaUniform: Uniform<number>;
	constructor(gamma = 2.2) {
		const gammaUniform = new Uniform(gamma);
		super("GammaCorrectionEffect", fragmentShader, {
			blendFunction: BlendFunction.NORMAL,
			uniforms: new Map([["gamma", gammaUniform]]),
		});
		this.gammaUniform = gammaUniform;
	}

	public setGamma(value: number) {
		this.gammaUniform.value = value;
	}
}

const fragmentShader = `
uniform float gamma;

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
    if (gamma == 0.0) {
        outputColor = inputColor;
        return;
    }
    vec3 color = pow(inputColor.rgb, vec3(1.0 / gamma));
    outputColor = vec4(color, inputColor.a);
}
`;
