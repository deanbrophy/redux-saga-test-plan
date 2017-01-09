import { effects, runSaga, utils } from 'redux-saga';
import SagaTestError from './SagaTestError';
import Map from './utils/Map';
import ArraySet from './utils/ArraySet';
import serializeEffect from './serializeEffect';
import { warn } from './utils/logging';
import { delay, schedule } from './utils/async';
import identity from './utils/identity';

import {
  ACTION_CHANNEL,
  CALL,
  CPS,
  FORK,
  NONE,
  PROMISE,
  PUT,
  RACE,
  SELECT,
  TAKE,
} from './keys';

const { asEffect, is } = utils;

const DEFAULT_TIMEOUT = 250;

const emptySet = {
  add() {},
  delete() { return false; },
};

function reportActualEffects(store, storeKey) {
  const values = store.values();

  if (values.length === 0) {
    return '';
  }

  const serializedEffects = values.map(
    (effect, i) => `${i + 1}. ${serializeEffect(effect, storeKey)}`,
  );

  return `\nActual:\n------\n${serializedEffects.join('\n')}\n`;
}

export default function expectSaga(generator, ...sagaArgs) {
  const effectStores = {
    [TAKE]: new ArraySet(),
    [PUT]: new ArraySet(),
    [RACE]: new ArraySet(),
    [CALL]: new ArraySet(),
    [CPS]: new ArraySet(),
    [FORK]: new ArraySet(),
    [SELECT]: new ArraySet(),
    [ACTION_CHANNEL]: new ArraySet(),
    [PROMISE]: new ArraySet(),
    [NONE]: emptySet,
  };

  const expectations = [];
  const queuedActions = [];
  const listeners = [];
  const forkedTasks = [];
  const outstandingForkEffects = new Map();

  let isWaitingOnTake = false;
  let stopDirty = false;

  let iterator;
  let mainTask;
  let mainTaskPromise;

  function getAllPromises() {
    return Promise.all([
      ...effectStores[PROMISE].values(),
      ...forkedTasks.map(task => task.done),
    ]);
  }

  function addForkedTask(task) {
    stopDirty = true;
    forkedTasks.push(task);
  }

  function cancelMainTask(timeout, timedOut) {
    if (stopDirty) {
      stopDirty = false;
      return scheduleStop(timeout);
    }

    if (timedOut) {
      warn(`Saga exceeded async timeout of ${timeout}ms`);
    }

    mainTask.cancel();

    return mainTaskPromise;
  }

  function scheduleStop(timeout) {
    let promise = schedule(getAllPromises).then(() => false);

    if (timeout > 0) {
      promise = Promise.race([
        promise,
        delay(timeout).then(() => true),
      ]);
    }

    return promise.then(
      timedOut => schedule(cancelMainTask, [timeout, timedOut]),
    );
  }

  function queueAction(action) {
    queuedActions.push(action);
  }

  function notifyListeners(value) {
    listeners.forEach((listener) => {
      listener(value);
    });
  }

  function notifyNextAction() {
    if (queuedActions.length > 0) {
      const action = queuedActions.shift();
      notifyListeners(action);
    }
  }

  function parseEffect(effect) {
    switch (true) {
      case is.promise(effect):
        return PROMISE;

      case is.notUndef(asEffect.take(effect)):
        return TAKE;

      case is.notUndef(asEffect.put(effect)):
        return PUT;

      case is.notUndef(asEffect.race(effect)):
        return RACE;

      case is.notUndef(asEffect.call(effect)):
        return CALL;

      case is.notUndef(asEffect.cps(effect)):
        return CPS;

      case is.notUndef(asEffect.fork(effect)):
        return FORK;

      case is.notUndef(asEffect.select(effect)):
        return SELECT;

      case is.notUndef(asEffect.actionChannel(effect)):
        return ACTION_CHANNEL;

      default:
        return NONE;
    }
  }

  function storeEffect(event) {
    const effectType = parseEffect(event.effect);
    const effectStore = effectStores[effectType];

    if (effectType === FORK) {
      const effect = asEffect.fork(event.effect);
      outstandingForkEffects.set(event.effectId, effect);
    }

    effectStore.add(event.effect);

    isWaitingOnTake = effectType === TAKE;

    if (isWaitingOnTake) {
      schedule(notifyNextAction);
    }
  }

  let storeState;

  const io = {
    subscribe(listener) {
      listeners.push(listener);

      return () => {
        const index = listeners.indexOf(listener);

        if (index !== -1) {
          listeners.splice(index, 1);
        }
      };
    },

    dispatch: notifyListeners,

    getState() {
      return storeState;
    },

    sagaMonitor: {
      effectTriggered(event) {
        storeEffect(event);
      },

      effectResolved(effectId, value) {
        const forkEffect = outstandingForkEffects.get(effectId);

        if (forkEffect) {
          addForkedTask(value);
        }
      },

      effectRejected() {},
      effectCancelled() {},
    },
  };

  const api = {
    dispatch,
    run,
    withState,

    actionChannel: createEffectTesterFromEffects('actionChannel', ACTION_CHANNEL),
    apply: createEffectTesterFromEffects('apply', CALL),
    call: createEffectTesterFromEffects('call', CALL),
    cps: createEffectTesterFromEffects('cps', CPS),
    fork: createEffectTesterFromEffects('fork', FORK),
    put: createEffectTesterFromEffects('put', PUT),
    race: createEffectTesterFromEffects('race', RACE),
    select: createEffectTesterFromEffects('select', SELECT),
    spawn: createEffectTesterFromEffects('spawn', FORK),
    take: createEffectTesterFromEffects('take', TAKE),
  };

  api.put.resolve = createEffectTester('put.resolve', PUT, effects.put.resolve);
  api.take.maybe = createEffectTester('take.maybe', TAKE, effects.take.maybe);

  function checkExpectations() {
    expectations.forEach(({ effectName, expectedEffect, store, storeKey }) => {
      const deleted = store.delete(expectedEffect);

      if (!deleted) {
        const serializedEffect = serializeEffect(expectedEffect, storeKey);
        let errorMessage = `\n${effectName} expectation unmet:` +
                           `\n\nExpected\n--------\n${serializedEffect}\n`;

        errorMessage += reportActualEffects(store, storeKey, effectName);

        throw new SagaTestError(errorMessage);
      }
    });
  }

  function dispatch(action) {
    if (isWaitingOnTake) {
      notifyListeners(action);
    } else {
      queueAction(action);
    }

    return api;
  }

  function start() {
    iterator = generator(...sagaArgs);

    mainTask = runSaga(iterator, io);

    mainTaskPromise = mainTask.done
      .then(checkExpectations)
      // Pass along the error instead of rethrowing or allowing to
      // bubble up to avoid PromiseRejectionHandledWarning
      .catch(identity);

    return api;
  }

  function stop(timeout = DEFAULT_TIMEOUT) {
    return scheduleStop(timeout).then((err) => {
      if (err) {
        throw err;
      }
    });
  }

  function run(timeout = DEFAULT_TIMEOUT) {
    start();
    return stop(timeout);
  }

  function withState(state) {
    storeState = state;
    return api;
  }

  function createEffectTester(effectName, storeKey, effectCreator) {
    return (...args) => {
      const expectedEffect = effectCreator(...args);

      expectations.push({
        effectName,
        expectedEffect,
        storeKey,
        store: effectStores[storeKey],
      });

      return api;
    };
  }

  function createEffectTesterFromEffects(effectName, storeKey) {
    return createEffectTester(effectName, storeKey, effects[effectName]);
  }

  return api;
}