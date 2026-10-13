import { create } from 'zustand';

import type { BootStatus } from '@/app-data';

/**
 * The signed-in screens' first-load status, for the back button, which lives above them (it must work
 * while they are loading). Null whenever no signed-in screen is mounted.
 */
export const useBootStatusStore = create<{ bootStatus: BootStatus | null }>(() => ({ bootStatus: null }));
