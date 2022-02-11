// Focusfriend

// used for debugging
const PERSIST_TO_CAL = true;

// NOTE: these hours are in ET
const DEFAULT_WORKDAY_START_HOUR = 12;
const DEFAULT_WORKDAY_END_HOUR = 20;
const DEFAULT_LUNCHTIME_START_HOUR = 15;
const DEFAULT_LUNCHTIME_END_HOUR = 17;

const FOCUS_TIME_MIN_HOURS = 2;
const LUNCH_TIME_MIN_MINUTES = 20;
const LUNCH_TIME_MAX_MINUTES = 60;

// Range in the parent Sheet from which to read settings.
const SETTINGS_RANGE = "A1:B100";

// NOTE: changing this should be considered a breaking change, since it's used
// to look up previously-created events for rescheduling purposes.
const EVENT_TYPE_TAG_KEY = "focusfriend";
const EVENT_TYPE = {
  FOCUS: "focus",
  LUNCH: "lunch",
};

/**
 * Conforms to the CalendarEvent API.
 */
class FfCalendarEvent {
  constructor(eventType, startEndTime) {
    this.type = eventType;
    this.startTime = startEndTime[0];
    this.endTime = startEndTime[1];
  }

  getStartTime() {
    return this.startTime;
  }

  getEndTime() {
    return this.endTime;
  }

  getType() {
    return this.type;
  }
}

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

  getLunchtimeStartHour() {
    return (
      this.settings["lunchtime_start_hour"]?.getHours() ||
      DEFAULT_LUNCHTIME_START_HOUR
    );
  }

  getLunchtimeEndHour() {
    return (
      this.settings["lunchtime_end_hour"]?.getHours() ||
      DEFAULT_LUNCHTIME_END_HOUR
    );
  }
}

/**
 * Extends Date to support adding days.
 *
 * via https://stackoverflow.com/a/563442
 */
Date.prototype.plusDays = function (days) {
  const date = new Date(this.valueOf());
  date.setDate(date.getDate() + days);
  return date;
};

/**
 * Extends Date to support adding minutes.
 */
Date.prototype.plusMinutes = function (minutes) {
  const date = new Date(this.valueOf());
  date.setTime(date.getTime() + minutes * 60 * 1000);
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
 * Finds all gaps in a schedule of events. Also applies bounds to gap-finding.
 */
function findGapsInSchedule(startBound, endBound, events) {
  const eventStartEnds = events.map((event) => [
    event.getStartTime(),
    event.getEndTime(),
  ]);

  // create placeholder events at bounds from which to anchor gaps
  eventStartEnds.unshift([startBound, startBound]);
  eventStartEnds.push([endBound, endBound]);

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
 * Schedules (and reschedules) all Focusfriend events for a given day.
 */
function scheduleEventsForDate(settings, dayDateTime) {
  Logger.info("------------");
  Logger.info(`Scheduling events for ${dayDateTime}`);

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

  const nextDayDateTime = dayDateTime.plusDays(1);
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
  if (PERSIST_TO_CAL) {
    allEvents
      .filter((event) => {
        return event.getTag(EVENT_TYPE_TAG_KEY);
      })
      .forEach((event) => {
        event.deleteEvent();
      });
  }

  // filter to the existing events that we have to schedule around, exluding the
  // previously-deleted focusfriend events
  const events = allEvents.filter((event) => !event.getTag(EVENT_TYPE_TAG_KEY));

  const lunchtimeStart = new Date(
    dayDateTime.getFullYear(),
    dayDateTime.getMonth(),
    dayDateTime.getDate(),
    settings.getLunchtimeStartHour()
  );

  const lunchtimeEnd = new Date(
    dayDateTime.getFullYear(),
    dayDateTime.getMonth(),
    dayDateTime.getDate(),
    settings.getLunchtimeEndHour()
  );

  const lunchEvent = calculateLunchEvent(lunchtimeStart, lunchtimeEnd, events);

  const eventsToSchedule = [];

  if (lunchEvent) {
    eventsToSchedule.push(lunchEvent);
    // add lunch event to events list so that focus time is scheduled around it
    events.push(lunchEvent);
  }

  eventsToSchedule.push.apply(
    eventsToSchedule,
    calculateFocusEvents(workdayStart, workdayEnd, events)
  );

  eventsToSchedule.forEach((event) => {
    createEvent(event);
  });
}

// calculate lunch event within bounds and around other events.
function calculateLunchEvent(startBound, endBound, events) {
  // find all gaps between events
  const gaps = findGapsInSchedule(startBound, endBound, events);

  // truncate gaps to start and end of lunch time
  // and filter to only long-enough gaps
  const potentialGaps = gaps
    .map((gap) => {
      let [gapStart, gapEnd] = gap;

      if (gapStart < startBound) {
        gapStart = startBound;
      }

      if (gapEnd > endBound) {
        gapEnd = endBound;
      }

      return [gapStart, gapEnd];
    })
    .filter((gap) => {
      const [gapStart, gapEnd] = gap;
      const gapMinutes = (gapEnd - gapStart) / 1000 / 60;
      return gapMinutes >= LUNCH_TIME_MIN_MINUTES;
    });

  if (potentialGaps.length === 0) {
    return;
  }

  // find the longest gap
  const longestGap = potentialGaps.reduce((longestGap, gap) => {
    if (!longestGap) {
      return gap;
    }
    if (gap[1] - gap[0] > longestGap[1] - longestGap[0]) {
      return gap;
    }
    return longestGap;
  });

  // schedule lunch during longest gap, capped to max lunch time
  const [lunchStart, lunchEnd] = longestGap;
  let appliedLunchEnd = lunchEnd;
  const lunchDurationMinutes = (lunchEnd - lunchStart) / 1000 / 60;
  if (lunchDurationMinutes > LUNCH_TIME_MAX_MINUTES) {
    appliedLunchEnd = lunchStart.plusMinutes(LUNCH_TIME_MAX_MINUTES);
  }

  return new FfCalendarEvent(EVENT_TYPE.LUNCH, [lunchStart, appliedLunchEnd]);
}

// calculate focus time events within bounds and around other events.
function calculateFocusEvents(startBound, endBound, events) {
  // find all gaps between events
  const gaps = findGapsInSchedule(startBound, endBound, events);

  // truncate gaps to start and end of work day
  // and filter to only long-enough gaps
  const applicableGaps = gaps
    .map((gap) => {
      let [gapStart, gapEnd] = gap;

      if (gapStart < startBound) {
        gapStart = startBound;
      }

      if (gapEnd > endBound) {
        gapEnd = endBound;
      }

      return [gapStart, gapEnd];
    })
    .filter((gap) => {
      const [gapStart, gapEnd] = gap;
      const gapHours = (gapEnd - gapStart) / 1000 / 60 / 60;
      return gapHours >= FOCUS_TIME_MIN_HOURS;
    });

  return applicableGaps.map((gap) => {
    return new FfCalendarEvent(EVENT_TYPE.FOCUS, gap);
  });
}

const EVENT_TYPE_NAMES = {
  [EVENT_TYPE.FOCUS]: "Focus Time",
  [EVENT_TYPE.LUNCH]: "Lunch",
};

/**
 * Wrapper for the CalendarApp.createEvent() interface. Creates event of the
 * provided type and sets the event tag.
 */
function createEvent(event) {
  const eventType = event.getType();
  const eventStartTime = event.getStartTime();
  const eventEndTime = event.getEndTime();
  const eventName = EVENT_TYPE_NAMES[eventType];
  if (PERSIST_TO_CAL) {
    const createdEvent = CalendarApp.createEvent(
      `⏰ ${eventName} ⏰ (via Focusfriend)`,
      eventStartTime,
      eventEndTime
    );
    createdEvent.setTag(EVENT_TYPE_TAG_KEY, eventType);
  }
  Logger.info(`Scheduled ${eventName}: ${eventStartTime} - ${eventEndTime}`);
}

/**
 * Entry point. Schedules Focusfriend events for the current week.
 */
function scheduleEvents() {
  const now = new Date();
  const dayOfWeek = now.getDay();
  const settings = new Settings();

  for (let i = dayOfWeek; i < 6; i++) {
    // don't schedule sunday
    if (i > 0) {
      scheduleEventsForDate(settings, now.plusDays(i - dayOfWeek));
    }
  }
}
