import { createApp } from './app';

const PORT = process.env.PORT ? Number(process.env.PORT) : 4000;

createApp().listen(PORT, () => {
  console.log(`Escrow API listening on port ${PORT}`);
});
