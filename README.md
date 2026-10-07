# Vistorias de Ativos · DTEL

Sistema web que substitui a planilha "Vistorias Semanais". Os supervisores registram as vistorias, o painel semanal calcula a conformidade por equipe e a Qualidade acompanha tudo.

O site é estático (HTML, CSS e JavaScript, sem etapa de build). O banco de dados e o login ficam no Supabase. A hospedagem é na Vercel, puxando o código do GitHub.

## Atualização da versão 2

Se o sistema já está no ar, faça só isto:

1. **Arquivos do site:** substitua no GitHub `index.html`, `styles.css` e `app.js` e envie a pasta `assets` (logo e selo). Não troque o `config.js`, que já está com as suas chaves. A Vercel publica sozinha em seguida.
2. **Banco:** rode `supabase/11_cadastros_e_relatorios.sql` no SQL Editor.
3. **E-mail semanal:** siga a seção "Relatório semanal por e-mail" abaixo. Ele usa o Gmail da Qualidade, sem conta nova nem TI.

## Estrutura

```
index.html        Telas do sistema
styles.css        Visual (verde e dourado DTEL)
app.js            Lógica e conexão com o Supabase
config.js         URL e chave pública do Supabase (você preenche)
assets/           Logo DTEL e Selo Qualidade
supabase/
  01_schema.sql                  Tabelas, regras e segurança
  02_seed_equipes_tecnicos.sql   14 equipes e 397 técnicos da aba Base
  03 a 06_seed_vistorias_*.sql   10.106 vistorias históricas (2023 a 2026)
  07_liberar_acessos.sql         Modelo para liberar usuários
  08 a 10                        Logins de supervisores e Qualidade
  11_cadastros_e_relatorios.sql  Gestores, supervisores, resumo e destinatários
  12_agendar_envio_semanal.sql   Agendamento do e-mail de segunda-feira
  functions/vistoria-relatorio-semanal/index.ts   Função que monta e envia o e-mail pelo Gmail
```

## Passo 1: Supabase

1. Crie uma conta em supabase.com e clique em **New project**. Escolha a região **South America (São Paulo)**.
2. Abra **SQL Editor > New query** e rode os arquivos da pasta `supabase` **na ordem**, um de cada vez: abra o arquivo, copie tudo, cole e clique em **Run**.
   - Se o editor reclamar do tamanho de algum arquivo de vistorias, use **Upload SQL file** ou divida o arquivo ao meio.
3. Crie os usuários em **Authentication > Users > Add user**. Informe e-mail e senha e marque **Auto Confirm User**.
4. Libere cada usuário com o arquivo `07_liberar_acessos.sql`. Cada usuário precisa ter um perfil:
   - **qualidade:** vê todas as equipes e pode corrigir registros;
   - **supervisor:** vê e lança somente a própria equipe.
5. Em **Authentication > Sign In / Providers**, desative **Allow new users to sign up**. Assim só entra quem a Qualidade cadastrar.
6. Em **Project Settings > API**, copie a **Project URL** e a **anon public key** e cole no `config.js`.

## Passo 2: testar no seu computador (opcional)

Na pasta do projeto, rode:

```
npx serve .
```

Depois abra o endereço que aparecer (normalmente http://localhost:3000). Abrir o `index.html` com duplo clique também funciona na maioria dos navegadores.

## Passo 3: GitHub

1. Crie um repositório novo em github.com, de preferência **privado**, por exemplo `vistorias-ativos`.
2. Na pasta do projeto, rode:

```
git init
git add .
git commit -m "Primeira versão do sistema de vistorias"
git branch -M main
git remote add origin https://github.com/SEU-USUARIO/vistorias-ativos.git
git push -u origin main
```

Se preferir não usar o terminal, dá para arrastar os arquivos na página do repositório (**Add file > Upload files**).

## Passo 4: Vercel

1. Entre em vercel.com com a conta do GitHub.
2. Clique em **Add New > Project** e importe o repositório.
3. Em **Framework Preset**, escolha **Other**. Deixe build e output em branco.
4. Clique em **Deploy**. O sistema fica disponível em `https://vistorias-ativos.vercel.app` (ou nome parecido).

A partir daí, cada `git push` publica a nova versão automaticamente.

## Nomes no banco

Todos os objetos desta aplicação começam com `vistoria_`, para conviver com outros sistemas no mesmo projeto do Supabase:

| Tabela | Conteúdo |
|---|---|
| `vistoria_equipes` | Equipes (antigas abas de cada gerente) |
| `vistoria_tecnicos` | Cadastro de técnicos (antiga aba Base) |
| `vistoria_perfis` | Quem acessa o sistema e de qual equipe |
| `vistoria_registros` | As vistorias lançadas |
| `vistoria_gestores` | Gestores e a equipe de cada um |
| `vistoria_supervisores` | Supervisores |
| `vistoria_destinatarios` | Quem recebe o relatório semanal |
| `vistoria_envios` | Registro de cada e-mail enviado |
| `vistoria_resumo_tecnicos` | Visão com total de vistorias por técnico |

As funções (`vistoria_meu_papel`, `vistoria_minha_equipe`), o gatilho e as regras de segurança seguem o mesmo prefixo. Os usuários de login (Authentication) são compartilhados entre as aplicações do projeto, mas só acessa este sistema quem tiver linha em `vistoria_perfis`.

## Regras que o banco garante sozinho

Essas regras ficam no Supabase, então valem mesmo que alguém tente burlar a tela:

- Supervisor só vê e lança vistorias da própria equipe (regra 1).
- Supervisor, gerente, cidade, base e equipe vêm do cadastro do técnico (regra 2).
- A conformidade é calculada pelos itens críticos: ONU, roteador, cabo de fibra e conectores (regra 3).
- Data futura e técnico inativo são recusados.
- Divergência marcada exige descrição.
- Depois de salva, só a Qualidade edita ou exclui a vistoria (regra 8).
- Só a Qualidade altera o cadastro de técnicos (regra 9).

## Relatório semanal por e-mail

Toda segunda-feira às 8h, o próprio Supabase envia **um único e-mail** com os gráficos da semana anterior, de todas as equipes:

- **De:** a conta Gmail da Qualidade.
- **Para:** a mesma conta, ou outro endereço se você definir `EMAIL_PARA`.
- **Cópia:** todos os e-mails ativos da tabela `vistoria_destinatarios`. Ela pode ser editada pela tela **Cadastros > Relatório por e-mail** ou pelo Table Editor.

### 1. Senha de app no Gmail

1. Entre na conta que vai enviar, por exemplo `qualidade@dtel.com.br`.
2. Ative a **Verificação em duas etapas** em myaccount.google.com > Segurança.
3. Na busca da conta Google, procure **Senhas de app**. Crie uma com o nome "Vistorias" e copie as 16 letras.

Se a opção "Senhas de app" não aparecer, o administrador do Google Workspace precisa liberar a verificação em duas etapas para a conta.

### 2. Publicar a função no Supabase

1. Abra **Edge Functions > Deploy a new function > Via Editor**.
2. Dê o nome exato `vistoria-relatorio-semanal`.
3. Apague o código de exemplo e cole o conteúdo de `supabase/functions/vistoria-relatorio-semanal/index.ts`.
4. Clique em **Deploy**.
5. Nos detalhes da função, desligue **Enforce JWT verification** (ou "Verify JWT"). A própria função confere quem está chamando.
6. Em **Edge Functions > Secrets**, cadastre:

| Nome | Valor |
|---|---|
| `GMAIL_USUARIO` | a conta que envia, ex.: `qualidade@dtel.com.br` |
| `GMAIL_SENHA_APP` | as 16 letras da senha de app |
| `RELATORIO_SEGREDO` | uma senha longa inventada por você |
| `APP_URL` | o endereço do sistema na Vercel, ex.: `https://vistorias-ativos.vercel.app` |
| `EMAIL_PARA` | opcional: destinatário principal; se não cadastrar, vai para o próprio `GMAIL_USUARIO` |

### 3. Testar e agendar

1. No sistema, vá em **Cadastros > Relatório por e-mail** e clique em **Enviar teste**. O e-mail chega só para você, marcado como [TESTE].
2. Ative **pg_cron** e **pg_net** em **Database > Extensions**.
3. Abra `supabase/12_agendar_envio_semanal.sql`, troque os dois valores marcados com TROQUE e rode no SQL Editor.

Cada envio fica registrado em **Últimos envios**, na mesma tela. Se falhar, o motivo aparece ali.

## Relatório em PDF

No **Painel semanal**, escolha ano, semana e equipe e clique em **Relatório em PDF**. Na janela de impressão, escolha **Salvar como PDF**. Para as cores saírem, deixe marcada a opção **Gráficos de plano de fundo**.

## Cadastro de técnicos

Fica na aba **Cadastros**, visível só para a Qualidade, com técnicos, supervisores, gestores, equipes e destinatários do e-mail.

- **Equipe do técnico:** é definida pelo gestor escolhido.
- **Desligamento:** desmarque "Técnico ativo". Não apague o técnico, porque o histórico de vistorias dele continua valendo.
- **Troca de supervisor ou gestor:** vale para as próximas vistorias. As antigas continuam com quem era responsável na época.
- **Nomes duplicados:** se o mesmo supervisor aparece com dois nomes (ex.: "NADSON BRUNO" e "NADSON BRUNO NAPOLEÃO DA SILVA"), passe os técnicos para um dos nomes e inative o outro.

## Observações sobre a importação

- **Registros descartados:** 79 linhas da planilha tinham data inválida ou futura e não foram importadas.
- **Status padronizados:** os status da aba Base foram padronizados para ativo e inativo. Técnicos sem status entraram como ativos.
- **Vistorias sem técnico na Base:** 2.232 vistorias antigas são de técnicos que não estão mais na aba Base. Elas foram mantidas com o nome gravado na própria vistoria.
- **Técnicos sem equipe:** os técnicos do gerente Gabriel Soares não têm equipe correspondente. Crie a equipe e ajuste o `equipe_id` deles quando definir.
