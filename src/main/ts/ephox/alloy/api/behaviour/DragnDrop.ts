import { Behaviour } from '@ephox/alloy';
import DragnDropBranches from '../../dragging/dragndrop/DragnDropBranches';
import { DragnDropBehaviour } from '../../dragging/dragndrop/DragnDropTypes';

const DragnDrop = Behaviour.createModes({
  branchKey: 'mode',
  branches: DragnDropBranches,
  name: 'dragndrop',
  active: {
    exhibit (base, dragInfo) {
      return dragInfo.instance.exhibit(base, dragInfo);
    },

    events (dragInfo) {
      return dragInfo.instance.handlers(dragInfo);
    }
  }
}) as DragnDropBehaviour;

export {
  DragnDrop
};
