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
  'minecraft:packed_ice': '#a9d6e5',
  'minecraft:bone_block': '#d9d2bd',
  'minecraft:iron_block': '#c9c9c9',
  'minecraft:soul_sand': '#6b5545',
  'minecraft:pumpkin': '#d98a2b',
  'minecraft:emerald_block': '#2fbf71',
  'minecraft:hay_block': '#c9a227',
  'minecraft:glowstone': '#e8c66a',
  'minecraft:stone': '#8a8a8a',
  'minecraft:sand': '#e2d3a3',
  'minecraft:glass': '#cfe8ea',
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
    'minecraft:dirt': '泥土 · 竖琴（钢琴音色）',
    'minecraft:grass_block': '草方块 · 竖琴',
    'minecraft:bedrock': '基岩 · 竖琴',
    'minecraft:oak_planks': '木板 · 贝斯',
    'minecraft:white_wool': '羊毛 · 吉他',
    'minecraft:clay': '黏土 · 长笛',
    'minecraft:gold_block': '金块 · 铃铛',
    'minecraft:packed_ice': '浮冰 · 钟琴',
    'minecraft:bone_block': '骨块 · 木琴',
    'minecraft:iron_block': '铁块 · 铁木琴',
    'minecraft:soul_sand': '灵魂沙 · 牛铃',
    'minecraft:pumpkin': '南瓜 · 迪吉里杜管',
    'minecraft:emerald_block': '绿宝石块 · 比特',
    'minecraft:hay_block': '干草块 · 班卓',
    'minecraft:glowstone': '萤石 · 电钢琴',
    'minecraft:stone': '石头 · 底鼓',
    'minecraft:sand': '沙子 · 军鼓',
    'minecraft:glass': '玻璃 · 踩镲',
  };
  return names[block] || shortName(block);
}

export { colorOf, displayBlockName };
