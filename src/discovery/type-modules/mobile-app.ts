import type { Question } from '../types.js';

export function mobileAppQuestions(): Question[] {
  return [
    { id: 'mobile_platforms', ask: 'Target platforms (iOS, Android, both, cross-platform)?', status: 'gap' },
    { id: 'mobile_offline', ask: 'Offline behavior requirements?', status: 'gap' },
    { id: 'mobile_push', ask: 'Push notifications needed?', status: 'gap' },
    { id: 'mobile_device_caps', ask: 'Device capabilities needed (camera, gps, bluetooth, etc.)?', status: 'gap' },
    { id: 'mobile_store', ask: 'App store constraints / release timeline?', status: 'gap' }
  ];
}

