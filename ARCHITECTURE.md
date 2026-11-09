# Decisões de Arquitetura

## Runtime e persistência

- Bun 1.x executa a aplicação NestJS e seus testes. O modo estrito do TypeScript está habilitado.
- TypeORM é usado para gerenciar o ciclo de vida das conexões e as migrations versionadas. As gravações financeiras usam SQL parametrizado por meio do `EntityManager` vinculado à transação, pois os locks de linha e consultivos do PostgreSQL, as constraints e o `SKIP LOCKED` são a base da consistência.
- `Money` armazena unidades monetárias menores como inteiros `bigint`; os contratos HTTP e de eventos usam strings decimais, e o PostgreSQL armazena valores exatos em `NUMERIC(20,2)`. Nenhum tipo de ponto flutuante binário é usado para valores monetários.
- As constraints do PostgreSQL garantem saldos não negativos em wallets e no ledger, unicidade de wallet por jogador e moeda, unicidade das chaves de idempotência e dos identificadores de transação do provedor, no máximo um lançamento de ledger por transação e imutabilidade do ledger por meio de um trigger no banco.

## Concorrência e idempotência

- As requisições adquirem um lock consultivo do PostgreSQL, vinculado à transação e derivado da chave de idempotência; em seguida, bloqueiam apenas a wallet afetada com `SELECT ... FOR UPDATE`. Wallets diferentes podem ser processadas em paralelo, e várias instâncias da aplicação compartilham esses locks do banco.
- O hash do payload é calculado com SHA-256 sobre um JSON cujas chaves são ordenadas recursivamente e que contém apenas campos de negócio. O cabeçalho de idempotência não faz parte do hash. Reenvios retornam o saldo persistido na resposta original; um payload diferente usando a mesma chave resulta em HTTP 409.
- A atualização da wallet, a inclusão do lançamento no ledger, o status da transação, o marcador de confirmação da inbox e os eventos de integração são confirmados em uma única transação SQL. A publicação da outbox acontece após o commit.

## Mensageria e recuperação

- O SQS FIFO é usado localmente apenas para ordenação e deduplicação no transporte. As constraints de unicidade e os locks do PostgreSQL continuam sendo a autoridade final.
- O consumidor SQS grava `(consumer_name, message_id)` na inbox na mesma transação dos efeitos financeiros e exclui a mensagem somente após o commit. Entregas com falha voltam a ficar visíveis após um intervalo exponencial e são encaminhadas à DLQ configurada após cinco recebimentos.
- Os publishers da outbox reservam linhas usando `FOR UPDATE SKIP LOCKED`. Uma falha após o envio e antes do commit pode publicar o mesmo evento novamente; os IDs dos eventos são estáveis e os consumidores devem ser idempotentes.
- Referências ausentes são armazenadas com status `PENDING_REFERENCE`, reprocessadas com backoff exponencial e rejeitadas com `REFERENCE_NOT_FOUND` após dez tentativas.

## Respostas HTTP e segurança

- `400`: payload inválido, chave de idempotência ausente ou tentativa de submeter `OPENING`, que é interno.
- `404`: wallet ou transação inexistente.
- `409`: wallet duplicada, divergência entre payloads para a mesma chave de idempotência ou conflito de identidade da transação.
- `202`: requisição aceita com status `PENDING_REFERENCE`.
- `422`: rejeição terminal de negócio; a resposta inclui um `failureCode` estável.
- Os endpoints de health não exigem autenticação. A autenticação foi intencionalmente deixada de fora porque não vale pontos no desafio; antes de produção, as rotas voltadas aos provedores devem ser protegidas por um provedor de identidade externo com OIDC e um guard de identidade do provedor. O sistema não armazena senhas.
- `GET /metrics` expõe contagens de transações por status, reenvios e tentativas adicionais persistidos, volume da DLQ, sessões do banco aguardando locks, atraso da outbox e latência média de processamento no formato texto do Prometheus.

## Limites de escopo definidos

- A stack local do Compose usa SQS via LocalStack; IAM da AWS em produção, políticas das filas, alarmes e escalabilidade automática são preocupações de implantação.
- O envelope dos eventos de integração é persistido como JSON na versão 1. Os tipos de payload dos eventos devem ser versionados à medida que novos consumidores forem adicionados.
- A reconciliação informa divergências sem corrigir saldos silenciosamente. As métricas são expostas por um endpoint de coleta; retenção operacional e dashboards dependem do ambiente.
- A solução não inclui contabilidade de partidas dobradas, provedor de autenticação ou alegações de resultados de testes de carga. Esses itens são acompanhamentos explícitos, não garantias implícitas.