const BLOCK_COLORS = {
  'minecraft:command_block': '#bd885c',
  'minecraft:chain_command_block': '#599c89',
  'minecraft:repeating_command_block': '#9475a5',
  'minecraft:redstone_wire': '#c74e4a',
  'minecraft:repeater': '#a3a19b',
  'minecraft:note_block': '#a86839',
  'minecraft:dirt': '#7a5230',
  'minecraft:grass_block': '#4e8f3d',
  'minecraft:bedrock': '#4a4a52',
  'minecraft:oak_planks': '#b98556',
  'minecraft:white_wool': '#e7e5df',
  'minecraft:clay': '#b98f84',
  'minecraft:gold_block': '#d8b443',
};

const FALLBACK_COLORS = ['#b8795f', '#8f9a72', '#c39a64', '#a58270', '#9b8d72', '#7e9690'];
const blockColors = new Map();

function colorOf(block, preview) {
  if (!block) return null;
  if (blockColors.has(block)) return blockColors.get(block);
  if (BLOCK_COLORS[block]) {
    blockColors.set(block, BLOCK_COLORS[block]);
    return BLOCK_COLORS[block];
  }
  const idx = preview.blocks.indexOf(block);
  const c = FALLBACK_COLORS[(idx < 0 ? 0 : idx) % FALLBACK_COLORS.length];
  blockColors.set(block, c);
  return c;
}

function shortName(block) {
  return block.replace(/^minecraft:/, '');
}

function displayBlockName(block) {
  const names = {
    'minecraft:command_block': '脉冲命令方块',
    'minecraft:chain_command_block': '连锁命令方块',
    'minecraft:repeating_command_block': '循环命令方块',
    'minecraft:redstone_wire': '红石线',
    'minecraft:repeater': '中继器',
    'minecraft:note_block': '音符盒',
    'minecraft:dirt': '泥土 · 中音钢琴',
    'minecraft:grass_block': '草方块音色',
    'minecraft:bedrock': '基岩音色',
    'minecraft:oak_planks': '木板 · 低音钢琴',
    'minecraft:white_wool': '羊毛 · 低中音钢琴',
    'minecraft:clay': '黏土 · 高中音钢琴',
    'minecraft:gold_block': '金块 · 高音钢琴',
  };
  return names[block] || shortName(block);
}

export { colorOf, shortName, displayBlockName };
