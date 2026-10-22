FROM node:20-alpine

WORKDIR /app
COPY package.json bot.js ./
COPY word_list.json materials/word_list.json
COPY words2.json materials/words2.json
COPY answer_keys.json materials/answer_keys.json

ENV DATA_FILE=/data/state.json
ENV MATERIALS_DIR=/app/materials
ENV TZ_OFFSET_MINUTES=300
ENV PORT=10000

VOLUME ["/data"]
EXPOSE 10000
CMD ["npm", "start"]
