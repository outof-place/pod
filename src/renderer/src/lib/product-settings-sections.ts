// Fork-only (Pod): Settings sections that exist only to configure Stably's hosted services.
import { areStablyServicesAvailable } from './product-ui-identity'

const STABLY_SERVICE_SECTION_IDS = new Set(['orca-account', 'mobile', 'artifacts', 'share-skills'])

export function withoutStablyServiceSections<T extends { id: string }>(sections: T[]): T[] {
  return areStablyServicesAvailable()
    ? sections
    : sections.filter((section) => !STABLY_SERVICE_SECTION_IDS.has(section.id))
}
