import { login, logout, whoami, configShow, configSet, configUnset } from './auth-commands';
import type { CommandDef } from './command';
import { eventsAdd, eventsDisable, eventsEnable, eventsGet, eventsList, eventsUpdate } from './event-commands';
import { examsAdd, examsRemove, examsUpdate } from './exam-commands';
import { help, schema } from './help-commands';
import { history, undo } from './journal-commands';
import { modesNormal, modesRangeAdd, modesRangeRemove, modesRuleSet, modesSwitch } from './mode-commands';
import { planApply, planCheck, planDiff } from './plan-commands';
import { prayers, qadaDone, qadaList } from './prayer-commands';
import { examsList, modesList, occurrences, passes, settingsGet, stats } from './read-commands';
import { settingsSet } from './settings-commands';

let cached: CommandDef[] | undefined;

/** Every command, in the order `help` lists them. Built on first use so the help command can list itself. */
export function allCommands(): CommandDef[] {
  cached ??= [
    login,
    logout,
    whoami,
    configShow,
    configSet,
    configUnset,
    eventsList,
    eventsGet,
    eventsAdd,
    eventsUpdate,
    eventsDisable,
    eventsEnable,
    occurrences,
    modesList,
    modesRuleSet,
    modesSwitch,
    modesNormal,
    modesRangeAdd,
    modesRangeRemove,
    examsList,
    examsAdd,
    examsUpdate,
    examsRemove,
    settingsGet,
    settingsSet,
    stats,
    prayers,
    qadaList,
    qadaDone,
    passes,
    planCheck,
    planDiff,
    planApply,
    undo,
    history,
    help,
    schema,
  ];
  return cached;
}
