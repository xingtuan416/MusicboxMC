import type { BlockState } from '../palette/noteBlock';
import type { BlockPlacement, Vec3 } from './types';

/**
 * Combine a block state with a position to form one placement in the layout result.
 *
 * The layout works with positioned blocks (BlockPlacement) while the palette describes
 * block states (name plus properties). Keeping the conversion here means **every block
 * the generator emits comes from a palette constructor**, so blockstate values and
 * their semantics - the repeater facing convention, a note block's powered flag, the
 * valid range of a dust block's power - are defined once and cannot be lost by hand-
 * writing a literal in the layout code.
 */
export function place(pos: Vec3, state: BlockState): BlockPlacement {
  return { pos, block: state.name, props: state.properties };
}
