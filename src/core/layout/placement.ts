import type { BlockState } from '../palette/noteBlock';
import type { BlockPlacement, Vec3 } from './types';

/**
 * 把「方块状态」与「坐标」组合成布局结果里的一个落位。
 *
 * 布局层需要带坐标的方块（BlockPlacement），而 palette 层描述的是方块状态本身
 * （name + properties）。转换只放在这里，好处是**生成器写出的每个方块都来自
 * palette 的构造函数**，blockstate 的取值与语义（中继器 facing 的方向约定、
 * 音符盒的 powered、红石粉的 power 范围）只有一处定义，不会在布局代码里
 * 手写字面量时漏掉某个属性。
 */
export function place(pos: Vec3, state: BlockState): BlockPlacement {
  return { pos, block: state.name, props: state.properties };
}
