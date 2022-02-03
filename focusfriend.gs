// Focusfriend

const PERSIST_TO_CAL = true;

// NOTE: these hours are in ET
const DEFAULT_WORKDAY_START_HOUR = 12;
const DEFAULT_WORKDAY_END_HOUR = 20;

const FOCUS_TIME_MIN_HOURS = 2;

// Range in the parent Sheet from which to read settings.
const SETTINGS_RANGE = "A1:B100";

// NOTE: changing this should be considered a breaking change, since it's used
// to look up previously-created events for rescheduling purposes.
const EVENT_TYPE_TAG_KEY = "focusfriend";
const EVENT_TYPE = {
  FOCUS: "focus",
};

/**
 * Exposes settings from the parent sheet.
 */
class Settings {
  constructor() {
    this.spreadsheet = SpreadsheetApp.getActive();
    this.settings = {};
    this.populateSettings();
  }

  // Reads settings from the sheet and populates member structure. Input range
  // to read is defined in SETTINGS_RANGE.
  populateSettings() {
    const settingValues = this.spreadsheet.getRange(SETTINGS_RANGE).getValues();
    settingValues.forEach((setting) => {
      const [settingKey, settingVal] = setting;
      if (settingKey != "") {
        this.settings[settingKey] = settingVal;
      }
    });
  }

  getWorkdayStartHour() {
    return (
      this.settings["workday_start_hour"]?.getHours() ||
      DEFAULT_WORKDAY_START_HOUR
    );
  }

  // TODO there's a bug when the workday_end_hour is >= 9PM PT. this is because
  // the date is implicitly stored in ET, and so the end hour falls on the next
  // day, and is before the start hour (i.e., it's Sun Dec 31 1899 00:00:00
  // GMT-0500 (Eastern Standard Time))
  getWorkdayEndHour() {
    return (
      this.settings["workday_end_hour"]?.getHours() || DEFAULT_WORKDAY_END_HOUR
    );
  }
}

/**
 * Extends Date to allow adding days.
 *
 * via https://stackoverflow.com/a/563442
 */
Date.prototype.addDays = function (days) {
  var date = new Date(this.valueOf());
  date.setDate(date.getDate() + days);
  return date;
};

/**
 * Orders events by start time and then by end time ascending.
 */
function eventStartEndsComparator(eventStartEndA, eventStartEndB) {
  const [eventStartA, eventEndA] = eventStartEndA;
  const [eventStartB, eventEndB] = eventStartEndB;

  if (eventStartA < eventStartB) return -1;
  if (eventStartB < eventStartA) return 1;

  // start at same time

  if (eventEndA < eventEndB) return -1;
  if (eventEndB < eventEndA) return 1;

  return 0;
}

/**
 * Finds all gaps in a schedule of events. Also applies workday start and end
 * settings to bound gap-finding.
 */
function findGapsInSchedule(workdayStart, workdayEnd, events) {
  const eventStartEnds = events.map((event) => [
    event.getStartTime(),
    event.getEndTime(),
  ]);

  // create placeholder events at start and end of work day to anchor gaps from
  eventStartEnds.unshift([workdayStart, workdayStart]);
  eventStartEnds.push([workdayEnd, workdayEnd]);

  // sort events
  eventStartEnds.sort(eventStartEndsComparator);

  // this reduction is kind of hard to understand. basically we're looking at
  // each event, one by one, and determining whether a gap starts or ends around
  // it. in this way we incrementally build up and refine the gap array.
  //
  // e.g., we determine a gap starts when an event ends. if that gap start falls
  // in the middle of another event, it means the two events were overlapping,
  // and so we shift the gap end later, etc.
  return eventStartEnds.reduce((gaps, eventStartEnd, index) => {
    const [eventStart, eventEnd] = eventStartEnd;
    const lastGap = gaps.slice(-1)[0];

    // gaps array is empty, trivially add the start of the first gap
    if (!lastGap) {
      gaps.push([eventEnd]);
      return gaps;
    }

    const [lastGapStart, lastGapEnd] = lastGap;

    // the last gap is only started
    if (!lastGapEnd) {
      if (eventStart > lastGapStart) {
        // add end of gap if the current event starts after the gap start
        gaps[gaps.length - 1] = [lastGapStart, eventStart];

        // add start of next gap unless this is the last event
        if (index !== eventStartEnds.length - 1) {
          gaps.push([eventEnd]);
        }
        return gaps;
      } else if (eventEnd > lastGapStart) {
        // update start of last gap if current event ends during or after the
        // gap start
        gaps[gaps.length - 1] = [eventEnd];
        return gaps;
      }
    }

    if (lastGapEnd < eventEnd) {
      // add next gap start
      gaps.push([eventEnd]);
      return gaps;
    }

    return gaps;
  }, []);
}

/**
 * Schedules (and reschedules) all focus time blocks for a given day.
 */
function scheduleFocusTimeForDate(settings, dayDateTime) {
  Logger.info(`Scheduling focus time for ${dayDateTime}`);

  const workdayStart = new Date(
    dayDateTime.getFullYear(),
    dayDateTime.getMonth(),
    dayDateTime.getDate(),
    settings.getWorkdayStartHour()
  );

  const workdayEnd = new Date(
    dayDateTime.getFullYear(),
    dayDateTime.getMonth(),
    dayDateTime.getDate(),
    settings.getWorkdayEndHour()
  );

  const nextDayDateTime = dayDateTime.addDays(1);
  const nextDayStart = new Date(
    nextDayDateTime.getFullYear(),
    nextDayDateTime.getMonth(),
    nextDayDateTime.getDate()
  );

  // get all non-declined events between current day and next day
  const allEvents = CalendarApp.getEvents(workdayStart, nextDayStart).filter(
    (event) => event.getMyStatus() !== CalendarApp.GuestStatus.NO
  );

  // delete events previously created by focusfriend
  allEvents
    .filter((event) => {
      return event.getTag(EVENT_TYPE_TAG_KEY);
    })
    .forEach((event) => {
      event.deleteEvent();
    });

  // filter to the existing events that we have to schedule around, exluding the
  // previously-deleted focusfriend events
  const events = allEvents.filter((event) => !event.getTag(EVENT_TYPE_TAG_KEY));

  // find all gaps between events
  const gaps = findGapsInSchedule(workdayStart, workdayEnd, events);

  // truncate gaps to start and end of work day
  // and filter to only long-enough gaps
  const appliedGaps = gaps
    .map((gap) => {
      let [appliedStart, appliedEnd] = gap;

      if (appliedStart < workdayStart) {
        appliedStart = workdayStart;
      }

      if (appliedEnd > workdayEnd) {
        appliedEnd = workdayEnd;
      }

      return [appliedStart, appliedEnd];
    })
    .filter((gap) => {
      const [gapStart, gapEnd] = gap;
      const gapHours = (gapEnd - gapStart) / 1000 / 60 / 60;
      return gapHours >= FOCUS_TIME_MIN_HOURS;
    });

  // create events of the appropriate type
  appliedGaps.forEach((gap) => {
    const [gapStart, gapEnd] = gap;
    if (PERSIST_TO_CAL) {
      createEvent(EVENT_TYPE.FOCUS, gapStart, gapEnd);
    }
  });

  Logger.info({ appliedGaps });
}

const EVENT_TYPE_NAMES = {
  [EVENT_TYPE.FOCUS]: "Focus Time",
};

/**
 * Wrapper for the CalendarApp.createEvent() interface. Creates event of the
 * provided type and sets the event tag.
 */
function createEvent(eventType, eventStart, eventEnd) {
  const eventName = EVENT_TYPE_NAMES[eventType];
  const createdEvent = CalendarApp.createEvent(
    `⏰ ${eventName} ⏰ (via Focusfriend)`,
    eventStart,
    eventEnd
  );
  createdEvent.setTag(EVENT_TYPE_TAG_KEY, eventType);
}

/**
 * Entry point. Schedules focus time for the current week.
 */
function scheduleFocusTime() {
  const now = new Date();
  const dayOfWeek = now.getDay();
  const settings = new Settings();

  // schedule focus time for the coming week
  for (let i = dayOfWeek; i < 6; i++) {
    // don't schedule sunday
    if (i > 0) {
      scheduleFocusTimeForDate(settings, now.addDays(i - dayOfWeek));
    }
  }
}
