// Deterministic Sponge v2 fixture. No Minecraft server or private schematic is required.
import { writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";

const width = 19,
	height = 5,
	length = 19;
const palette = new Map([["minecraft:air", 0]]);
const blocks = new Uint8Array(width * height * length);
const entities = [];
function put(x, y, z, state, entity) {
	if (!palette.has(state)) palette.set(state, palette.size);
	blocks[x + z * width + y * width * length] = palette.get(state);
	if (entity) entities.push({ Id: [8, entity.id], Pos: [11, [x, y, z]], ...entity.tags });
}
for (let x = 0; x < width; x++)
	for (let z = 0; z < length; z++) put(x, 0, z, "minecraft:smooth_stone");
const states = [
	"mangrove_log[axis=y]",
	"stripped_mangrove_log[axis=y]",
	"mangrove_leaves[persistent=true,distance=1]",
	"bush",
	"leaf_litter[facing=north,segment_amount=4]",
	"water_cauldron[level=3]",
	"lava_cauldron",
	"heavy_core",
	"oak_shelf[facing=south,side_chain=unconnected]",
	"oak_stairs[facing=north,half=top,shape=straight,waterlogged=false]",
	"oak_stairs[facing=south,half=top,shape=inner_left,waterlogged=false]",
	"oak_stairs[facing=west,half=bottom,shape=outer_right,waterlogged=false]",
	"oak_trapdoor[facing=north,half=top,open=false,powered=false,waterlogged=false]",
	"oak_trapdoor[facing=east,half=bottom,open=true,powered=false,waterlogged=false]",
	"lectern[facing=south,has_book=true,powered=false]",
	"lectern[facing=west,has_book=false,powered=false]",
	"fire[age=0,east=false,north=false,south=false,up=false,west=false]",
	"glow_lichen[down=false,east=false,north=false,south=false,up=true,west=false,waterlogged=false]",
	"shulker_box[facing=up]",
	"red_shulker_box[facing=north]",
	"blue_shulker_box[facing=east]",
	"yellow_shulker_box[facing=down]",
	"green_shulker_box[facing=south]",
	"purple_shulker_box[facing=west]",
	"copper_chest[facing=south,type=single,waterlogged=false]",
	"exposed_copper_chest[facing=south,type=single,waterlogged=false]",
	"oxidized_copper_chest[facing=west,type=single,waterlogged=false]",
];
states.forEach((state, i) =>
	put(1 + (i % 9) * 2, 1, 1 + Math.floor(i / 9) * 3, `minecraft:${state}`)
);
put(3, 1, 10, "minecraft:weathered_copper_chest[facing=south,type=left,waterlogged=false]");
put(4, 1, 10, "minecraft:weathered_copper_chest[facing=south,type=right,waterlogged=false]");
for (let i = 0; i < 4; i++) {
	const facing = ["south", "west", "north", "east"][i];
	put(
		7 + i * 2,
		1,
		10,
		`minecraft:decorated_pot[facing=${facing},cracked=false,waterlogged=false]`,
		{
			id: "minecraft:decorated_pot",
			tags: {
				sherds: [
					9,
					[
						8,
						[
							"minecraft:angler_pottery_sherd",
							"minecraft:archer_pottery_sherd",
							"minecraft:arms_up_pottery_sherd",
							"minecraft:prize_pottery_sherd",
						],
					],
				],
			},
		}
	);
}
for (let i = 0; i < 4; i++) {
	put(
		1 + i * 3,
		1,
		13,
		`minecraft:${["white", "blue", "red", "yellow"][i]}_banner[rotation=${i * 4}]`,
		{
			id: "minecraft:banner",
			tags: {
				Patterns: [
					9,
					[
						10,
						[
							{ Color: [3, 14], Pattern: [8, "cs"] },
							{ Color: [3, 0], Pattern: [8, "bo"] },
						],
					],
				],
			},
		}
	);
	put(1 + i * 3, 1, 16, `minecraft:player_head[rotation=${i * 4}]`, {
		id: "minecraft:skull",
		tags: {},
	});
}
put(13, 2, 13, "minecraft:blue_wall_banner[facing=south]", {
	id: "minecraft:banner",
	tags: { Patterns: [9, [10, [{ Color: [3, 0], Pattern: [8, "cre"] }]]] },
});
put(13, 1, 16, "minecraft:player_wall_head[facing=south]", { id: "minecraft:skull", tags: {} });

function integer(value, size) {
	const result = Buffer.alloc(size);
	result.writeIntBE(value, 0, size);
	return result;
}
function string(value) {
	const bytes = Buffer.from(value);
	return Buffer.concat([integer(bytes.length, 2), bytes]);
}
function payload(type, value) {
	switch (type) {
		case 2:
			return integer(value, 2);
		case 3:
			return integer(value, 4);
		case 7:
			return Buffer.concat([integer(value.length, 4), Buffer.from(value)]);
		case 8:
			return string(value);
		case 9:
			return Buffer.concat([
				Buffer.from([value[0]]),
				integer(value[1].length, 4),
				...value[1].map((v) => payload(value[0], v)),
			]);
		case 10:
			return Buffer.concat([
				...Object.entries(value).map(([key, [t, v]]) =>
					Buffer.concat([Buffer.from([t]), string(key), payload(t, v)])
				),
				Buffer.from([0]),
			]);
		case 11:
			return Buffer.concat([integer(value.length, 4), ...value.map((v) => integer(v, 4))]);
		default:
			throw new Error(`Unsupported fixture tag ${type}`);
	}
}
const root = {
	Version: [3, 2],
	DataVersion: [3, 3955],
	Width: [2, width],
	Height: [2, height],
	Length: [2, length],
	Offset: [11, [0, 0, 0]],
	PaletteMax: [3, palette.size],
	Palette: [10, Object.fromEntries([...palette].map(([name, index]) => [name, [3, index]]))],
	BlockData: [7, blocks],
	BlockEntities: [9, [10, entities]],
};
const nbt = Buffer.concat([Buffer.from([10]), string("Schematic"), payload(10, root)]);
await writeFile(
	new URL("../test/public/schematics/rendering-features.schem", import.meta.url),
	gzipSync(nbt)
);
console.log(
	`Generated ${width} × ${height} × ${length} fixture, ${palette.size} states, ${entities.length} block entities.`
);
