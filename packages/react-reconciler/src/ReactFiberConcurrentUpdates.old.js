/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {FiberRoot} from './ReactInternalTypes';
import type {
  UpdateQueue as HookQueue,
  Update as HookUpdate,
} from './ReactFiberHooks.old';
import type {
  SharedQueue as ClassQueue,
  Update as ClassUpdate,
} from './ReactFiberClassUpdateQueue.old';
import type {Lane} from './ReactFiberLane.old';

import {warnAboutUpdateOnNotYetMountedFiberInDEV} from './ReactFiberWorkLoop.old';
import {mergeLanes} from './ReactFiberLane.old';
import {NoFlags, Placement, Hydrating} from './ReactFiberFlags';
import {HostRoot} from './ReactWorkTags';

// An array of all update queues that received updates during the current
// render. When this render exits, either because it finishes or because it is
// interrupted, the interleaved updates will be transferred onto the main part
// of the queue.
let concurrentQueues: Array<
  HookQueue<any, any> | ClassQueue<any>,
> | null = null;

export function pushConcurrentUpdateQueue(
  queue: HookQueue<any, any> | ClassQueue<any>,
) {
  if (concurrentQueues === null) { // concurrentQueues存的只是updateQueue中share的一个指针，这里面的queue更改。fiber上 updateQueue中share也会对应更改
    concurrentQueues = [queue];
  } else {
    concurrentQueues.push(queue);
  }
}

export function finishQueueingConcurrentUpdates() { // 合并interleaved和pending。为啥要搞这个
  // Transfer the interleaved updates onto the main queue. Each queue has a
  // `pending` field and an `interleaved` field. When they are not null, they
  // point to the last node in a circular linked list. We need to append the
  // interleaved list to the end of the pending list by joining them into a
  // single, circular list.
  if (concurrentQueues !== null) {
    for (let i = 0; i < concurrentQueues.length; i++) {
      const queue = concurrentQueues[i];
      const lastInterleavedUpdate = queue.interleaved;
      if (lastInterleavedUpdate !== null) {
        queue.interleaved = null;
        const firstInterleavedUpdate = lastInterleavedUpdate.next; // 把暂存的update更新到将要更新的pending上去，先切开，然后组成环形链表
        const lastPendingUpdate = queue.pending;
        if (lastPendingUpdate !== null) {
          const firstPendingUpdate = lastPendingUpdate.next;
          lastPendingUpdate.next = (firstInterleavedUpdate: any);
          lastInterleavedUpdate.next = (firstPendingUpdate: any);
        }
        queue.pending = (lastInterleavedUpdate: any);
      }
    }
    concurrentQueues = null;
  }
}

export function enqueueConcurrentHookUpdate<S, A>(
  fiber: Fiber,
  queue: HookQueue<S, A>,
  update: HookUpdate<S, A>,
  lane: Lane,
) {
  const interleaved = queue.interleaved;
  if (interleaved === null) {
    // This is the first update. Create a circular list.
    update.next = update;
    // At the end of the current render, this queue's interleaved updates will
    // be transferred to the pending queue.
    pushConcurrentUpdateQueue(queue);
  } else {
    update.next = interleaved.next;
    interleaved.next = update;
  }
  queue.interleaved = update;

  return markUpdateLaneFromFiberToRoot(fiber, lane);
}

export function enqueueConcurrentHookUpdateAndEagerlyBailout<S, A>(
  fiber: Fiber,
  queue: HookQueue<S, A>,
  update: HookUpdate<S, A>,
  lane: Lane,
): void {
  const interleaved = queue.interleaved;
  if (interleaved === null) {
    // This is the first update. Create a circular list.
    update.next = update;
    // At the end of the current render, this queue's interleaved updates will
    // be transferred to the pending queue.
    pushConcurrentUpdateQueue(queue);
  } else {
    update.next = interleaved.next;
    interleaved.next = update;
  }
  queue.interleaved = update;
}

export function enqueueConcurrentClassUpdate<State>(
  fiber: Fiber, // fiebr
  queue: ClassQueue<State>, // sharing
  update: ClassUpdate<State>, // 当前更新
  lane: Lane,
) {
  const interleaved = queue.interleaved;
  if (interleaved === null) {
    // This is the first update. Create a circular list.
    update.next = update;
    // At the end of the current render, this queue's interleaved updates will
    // be transferred to the pending queue.
    pushConcurrentUpdateQueue(queue);
  } else {
    update.next = interleaved.next;
    interleaved.next = update;
  }
  queue.interleaved = update; // 构成一个环形链表

  // 一直向上找到根节点
  return markUpdateLaneFromFiberToRoot(fiber, lane); // 返回的是根节点的stateNode，也就是fiberRoot。所以我们调度是从根节点fiberRoot开始调度的
}

export function enqueueConcurrentRenderForLane(fiber: Fiber, lane: Lane) {
  return markUpdateLaneFromFiberToRoot(fiber, lane);
}

// Calling this function outside this module should only be done for backwards
// compatibility and should always be accompanied by a warning.
export const unsafe_markUpdateLaneFromFiberToRoot = markUpdateLaneFromFiberToRoot;

function markUpdateLaneFromFiberToRoot( // 更新现在这个fiber的优先级，并且找到我们的FiberRootNode，所有的更新都是从FiberRootNode开始的
  sourceFiber: Fiber,
  lane: Lane,
): FiberRoot | null {
  // Update the source fiber's lanes
  sourceFiber.lanes = mergeLanes(sourceFiber.lanes, lane);
  let alternate = sourceFiber.alternate;
  if (alternate !== null) {
    alternate.lanes = mergeLanes(alternate.lanes, lane);
  }
  if (__DEV__) {
    if (
      alternate === null &&
      (sourceFiber.flags & (Placement | Hydrating)) !== NoFlags
    ) {
      warnAboutUpdateOnNotYetMountedFiberInDEV(sourceFiber);
    }
  }
  // Walk the parent path to the root and update the child lanes.
  let node = sourceFiber;
  let parent = sourceFiber.return;
  while (parent !== null) {
    parent.childLanes = mergeLanes(parent.childLanes, lane); // 将孩子的更新合并到父亲上
    alternate = parent.alternate;
    if (alternate !== null) {
      alternate.childLanes = mergeLanes(alternate.childLanes, lane);
    } else {
      if (__DEV__) {
        if ((parent.flags & (Placement | Hydrating)) !== NoFlags) {
          warnAboutUpdateOnNotYetMountedFiberInDEV(sourceFiber);
        }
      }
    }
    node = parent;
    parent = parent.return;
  }
  if (node.tag === HostRoot) {
    const root: FiberRoot = node.stateNode; // 找到fiberRootNode
    return root;
  } else {
    return null;
  }
}
