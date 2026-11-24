import { dashboard } from './dashboard.js';
import { inventory, materials, materialDetail } from './materials.js';
import { pos } from './pos.js';
import { sales } from './sales.js';
import { utang } from './utang.js';
import { attendance } from './attendance.js';
import { expenses } from './expenses.js';
import { reports } from './reports.js';
import { staff } from './staff.js';
import { profile } from './profile.js';
import { settings } from './settings.js';
import { sync } from './sync.js';
import { orders } from './orders.js';
import { cash } from './cash.js';
import { summary } from './summary.js';

export const pages = {
  dashboard,
  inventory,
  materials: ctx => ctx.params[0] ? materialDetail(ctx) : materials(ctx),
  pos, sales, utang, attendance, expenses, reports, staff, profile, settings, sync, orders, cash, summary,
};
