/** Load .env from the backend folder before anything reads process.env (production: the host sets the variables). */
import dotenv from 'dotenv';

dotenv.config();
