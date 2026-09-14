import { closeProviderTaskStore, listProviderTaskSummaries } from '../src/lib/providers/taskStore';
try { console.log(JSON.stringify(listProviderTaskSummaries({ mode: 'video' }))); }
finally { closeProviderTaskStore(); }
