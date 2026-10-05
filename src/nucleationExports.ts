// One native WASM instance, with compatibility facades for the renderer's public API.
export {
	SchematicWrapper,
	BlockStateWrapper,
	SchematicBuilderWrapper,
	DiffWrapper,
} from "./nucleation/SchematicWrapper";
export { SimulationOptionsWrapper, MchprsWorldWrapper } from "./nucleation/simulation";
export { DefinitionRegionWrapper, BlockPosition, SortStrategyWrapper } from "./nucleation/regions";
export {
	TypedCircuitExecutorWrapper,
	ExecutionModeWrapper,
	IoLayoutBuilderWrapper,
	IoTypeWrapper,
	LayoutFunctionWrapper,
	IoLayoutWrapper,
	ValueWrapper,
	OutputConditionWrapper,
	CircuitBuilderWrapper,
	StateModeConstants,
} from "./nucleation/circuits";

export { initializeNucleationWasm } from "./nucleation/runtime";
