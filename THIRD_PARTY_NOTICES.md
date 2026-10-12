# Third-party notices

Alarm Calendar is source-available under the PolyForm Strict License 1.0.0 (see `LICENSE`). It
includes the third-party material below. Each package's own license text ships in its npm
package; the versions are the ones locked in `pnpm-lock.yaml`.

## Public holiday data

Public holiday data: date-holidays by commenthol, CC BY 3.0, https://github.com/commenthol/date-holidays

`date-holidays` 3.37.0 supplies the public holidays of a chosen country on the calendar. Its code
is ISC licensed; its holiday data is licensed under Creative Commons Attribution 3.0 (CC BY 3.0,
https://creativecommons.org/licenses/by/3.0/). The data is used unmodified apart from being read
into this app's own holiday type, and the app shifts Hijri-dated dates by the person's own
adjustment at display time.

| Package | Version | License |
| --- | --- | --- |
| date-holidays (code) | 3.37.0 | ISC |
| date-holidays (holiday data) | 3.37.0 | CC BY 3.0 |

## Packages bundled with it

These are what `date-holidays` pulls into the lazily loaded holiday chunk (its parser and the
parser's runtime dependencies).

| Package | Version | License |
| --- | --- | --- |
| date-holidays-parser | 3.4.7 | ISC |
| astronomia | 4.2.0 | MIT |
| caldate | 2.0.5 | ISC |
| date-bengali-revised | 2.0.2 | MIT |
| date-chinese | 2.1.4 | MIT |
| date-easter | 1.0.3 | MIT |
| deepmerge | 4.3.1 | MIT |
| jalaali-js | 1.2.8 | MIT |
| moment | 2.31.0 | MIT |
| moment-timezone | 0.5.48 | MIT |

## Other dependencies

The remaining runtime dependencies (React, FullCalendar, Supabase client, adhan, date-fns,
Electron and others) are listed with their licenses in `package.json` and `pnpm-lock.yaml` and
carry their own license files in `node_modules`.
