import { MemoryScanStore } from '../src/scan/memoryStore';
import { storeConformance } from './storeConformance';

storeConformance('MemoryScanStore', async () => new MemoryScanStore());
