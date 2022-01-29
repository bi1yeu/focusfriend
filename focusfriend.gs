// Focusfriend

const PERSIST_TO_CAL = true;

// NOTE: these hours are in ET
const DEFAULT_WORKDAY_START_HOUR = 12;
const DEFAULT_WORKDAY_END_HOUR = 20;

const FOCUS_TIME_MIN_HOURS = 2;

const SETTINGS_RANGE = "A1:B100";

// Gets settings from parent Sheet
class Settings {
  constructor() {
    this.spreadsheet = SpreadsheetApp.getActive();
    this.settings = {};
    this.populateSettings();
  }

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

// via https://stackoverflow.com/a/563442
Date.prototype.addDays = function (days) {
  var date = new Date(this.valueOf());
  date.setDate(date.getDate() + days);
  return date;
};

// orders by start time and then end time ascending
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

// finds gaps in the schedule of event start and ends
function findGapsInSchedule(eventStartEnds) {
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

function scheduleFocusTimeForDate(settings, dayDateTime) {
  Logger.info(`Scheduling focus time for ${dayDateTime}`);

  const workdayStart = new Date(
    dayDateTime.getFullYear(),
    dayDateTime.getMonth(),
    dayDateTime.getDate(),
    settings.getWorkdayStartHour()
  );

  const dayEnd = new Date(
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
  const events = CalendarApp.getEvents(workdayStart, nextDayStart).filter(
    (event) => event.getMyStatus() !== CalendarApp.GuestStatus.NO
  );

  const eventStartEnds = events.map((event) => [
    event.getStartTime(),
    event.getEndTime(),
  ]);

  // create placeholder events at start and end of work day to anchor gaps from
  eventStartEnds.unshift([workdayStart, workdayStart]);
  eventStartEnds.push([dayEnd, dayEnd]);

  // sort events
  eventStartEnds.sort(eventStartEndsComparator);
  // find all gaps between events
  const gaps = findGapsInSchedule(eventStartEnds);


  // truncate gaps to start and end of work day
  // and filter to only long-enough gaps
  const appliedGaps = gaps
    .map((gap) => {
      let [appliedStart, appliedEnd] = gap;

      if (appliedStart < workdayStart) {
        appliedStart = workdayStart;
      }

      if (appliedEnd > dayEnd) {
        appliedEnd = dayEnd;
      }

      return [appliedStart, appliedEnd];
    })
    .filter((gap) => {
      const [gapStart, gapEnd] = gap;
      const gapHours = (gapEnd - gapStart) / 1000 / 60 / 60;
      return gapHours >= FOCUS_TIME_MIN_HOURS;
    });

  appliedGaps.forEach((gap) => {
    const [gapStart, gapEnd] = gap;
    if (PERSIST_TO_CAL) {
      CalendarApp.createEvent(
        "⏰ Focus Time ⏰ (via Focusfriend)",
        gapStart,
        gapEnd
      );
    }
  });

  Logger.info({ appliedGaps });
}

function scheduleFocusTime() {
  const now = new Date();
  const dayOfWeek = now.getDay();
  const settings = new Settings();

  // schedule focus time for the coming week
  for (let i = dayOfWeek; i < 6; i++) {
    scheduleFocusTimeForDate(settings, now.addDays(i - dayOfWeek));
  }
}
