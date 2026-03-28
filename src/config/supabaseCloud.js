import { createClient } from '@supabase/supabase-js';

// DB: bodega 2 base de datos (fgzwmwrugerptfqfrsjd)
const supabaseUrl = 'https://fgzwmwrugerptfqfrsjd.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZnendtd3J1Z2VycHRmcWZyc2pkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ3MjA2ODgsImV4cCI6MjA5MDI5NjY4OH0.vi4iEyxWL7vmrb5OLe0mwQ0ozwpyNMYFqSTJzpnT9SM';

// Exportando cliente de supabase para los backups vinculados a la cuenta Cloud (email/password)
export const supabaseCloud = createClient(supabaseUrl, supabaseKey);
